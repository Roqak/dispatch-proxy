//! gRPC calls with messages described at run time: services come from server
//! reflection or from .proto files, and messages are written and shown as JSON.
//! Unary, server-streaming and single-message bidi calls are supported.

use prost::Message as _;
use prost_reflect::{DescriptorPool, DynamicMessage, MessageDescriptor, MethodDescriptor, SerializeOptions};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tonic::codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder};
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};
use tonic::Status;

#[derive(Default)]
pub struct GrpcState {
    /// Descriptor pools by source ("reflect:<target>" or "protos:<paths>").
    pools: Mutex<HashMap<String, DescriptorPool>>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MethodInfo {
    pub name: String,
    /// "package.Service/Method", as used on the wire.
    pub path: String,
    pub input: String,
    pub output: String,
    pub client_streaming: bool,
    pub server_streaming: bool,
    /// The input message with every field at its default, as JSON.
    pub template: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct ServiceInfo {
    pub name: String,
    pub methods: Vec<MethodInfo>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    /// "localhost:50051", "http://…" or "https://…" / "grpcs://…" for TLS.
    pub target: String,
    /// .proto files to use instead of server reflection.
    #[serde(default)]
    pub protos: Vec<String>,
    /// Import paths for the .proto files (their folders are added automatically).
    #[serde(default)]
    pub includes: Vec<String>,
    #[serde(default)]
    pub metadata: Vec<(String, String)>,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CallResult {
    pub code: i32,
    pub code_name: String,
    pub message: String,
    pub headers: Vec<(String, String)>,
    pub trailers: Vec<(String, String)>,
    pub messages: Vec<String>,
    pub time_ms: u128,
}

impl GrpcState {
    fn key(src: &Source) -> String {
        if src.protos.is_empty() { format!("reflect:{}", src.target.trim()) } else { format!("protos:{}", src.protos.join("|")) }
    }

    pub async fn describe(&self, src: &Source) -> Result<Vec<ServiceInfo>, String> {
        let pool = if src.protos.is_empty() { reflect(src).await? } else { compile(src)? };
        let services = list(&pool);
        self.pools.lock().unwrap_or_else(|p| p.into_inner()).insert(Self::key(src), pool);
        Ok(services)
    }

    pub async fn call(&self, src: &Source, path: &str, json: &str, on_message: impl Fn(String)) -> Result<CallResult, String> {
        let cached = self.pools.lock().unwrap_or_else(|p| p.into_inner()).get(&Self::key(src)).cloned();
        let pool = match cached { Some(p) => p, None => { self.describe(src).await?; self.pools.lock().unwrap_or_else(|p| p.into_inner()).get(&Self::key(src)).cloned().ok_or("No services found.")? } };
        let method = find_method(&pool, path)?;
        if method.is_client_streaming() && !method.is_server_streaming() {
            return Err("Client-streaming methods aren't supported yet; unary, server-streaming and bidi with one message are.".into());
        }
        let input = parse_json(method.input(), json)?;
        let channel = connect(&src.target).await?;
        let mut grpc = tonic::client::Grpc::new(channel);
        grpc.ready().await.map_err(|e| format!("The server isn't ready: {e}"))?;
        let mut request = tonic::Request::new(input);
        for (k, v) in &src.metadata {
            let key = tonic::metadata::MetadataKey::from_bytes(k.trim().to_ascii_lowercase().as_bytes()).map_err(|_| format!("\"{k}\" isn't a valid metadata key"))?;
            let val = v.parse().map_err(|_| format!("The value of \"{k}\" isn't valid metadata"))?;
            request.metadata_mut().insert(key, val);
        }
        let wire: tonic::codegen::http::uri::PathAndQuery = format!("/{}/{}", method.parent_service().full_name(), method.name()).parse().map_err(|_| "Bad method path")?;
        let started = Instant::now();
        let codec = DynCodec { output: method.output() };
        let mut result = CallResult::default();
        let response = grpc.server_streaming(request, wire, codec).await;
        match response {
            Err(status) => fill_status(&mut result, &status),
            Ok(resp) => {
                result.headers = meta(resp.metadata());
                let mut stream = resp.into_inner();
                loop {
                    match stream.message().await {
                        Ok(Some(msg)) => {
                            let text = to_json(&msg)?;
                            on_message(text.clone());
                            result.messages.push(text);
                        }
                        Ok(None) => {
                            result.code_name = "OK".into();
                            if let Ok(Some(t)) = stream.trailers().await { result.trailers = meta(&t); }
                            break;
                        }
                        Err(status) => { fill_status(&mut result, &status); break; }
                    }
                }
            }
        }
        result.time_ms = started.elapsed().as_millis();
        Ok(result)
    }
}

fn fill_status(r: &mut CallResult, s: &Status) {
    r.code = s.code() as i32;
    r.code_name = format!("{:?}", s.code());
    r.message = s.message().to_string();
    r.trailers = meta(s.metadata());
}

fn meta(m: &tonic::metadata::MetadataMap) -> Vec<(String, String)> {
    m.clone().into_headers().iter().map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).to_string())).collect()
}

fn find_method(pool: &DescriptorPool, path: &str) -> Result<MethodDescriptor, String> {
    let (svc, name) = path.trim_start_matches('/').rsplit_once('/').ok_or_else(|| format!("\"{path}\" should look like package.Service/Method"))?;
    let service = pool.get_service_by_name(svc).ok_or_else(|| format!("No service \"{svc}\""))?;
    let found = service.methods().find(|m| m.name() == name);
    found.ok_or_else(|| format!("{svc} has no method \"{name}\""))
}

fn to_json(msg: &DynamicMessage) -> Result<String, String> {
    let mut out = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(&mut out, serde_json::ser::PrettyFormatter::with_indent(b"  "));
    msg.serialize_with_options(&mut ser, &SerializeOptions::new().skip_default_fields(false)).map_err(|e| e.to_string())?;
    String::from_utf8(out).map_err(|e| e.to_string())
}

fn parse_json(desc: MessageDescriptor, json: &str) -> Result<DynamicMessage, String> {
    let text = if json.trim().is_empty() { "{}" } else { json };
    let mut de = serde_json::Deserializer::from_str(text);
    let msg = DynamicMessage::deserialize(desc.clone(), &mut de).map_err(|e| format!("The message doesn't match {}: {e}", desc.full_name()))?;
    de.end().map_err(|e| format!("Extra text after the message: {e}"))?;
    Ok(msg)
}

fn list(pool: &DescriptorPool) -> Vec<ServiceInfo> {
    let mut out: Vec<ServiceInfo> = pool
        .services()
        .filter(|s| !s.full_name().starts_with("grpc.reflection."))
        .map(|s| ServiceInfo {
            name: s.full_name().to_string(),
            methods: s
                .methods()
                .map(|m| MethodInfo {
                    name: m.name().to_string(),
                    path: format!("{}/{}", s.full_name(), m.name()),
                    input: m.input().full_name().to_string(),
                    output: m.output().full_name().to_string(),
                    client_streaming: m.is_client_streaming(),
                    server_streaming: m.is_server_streaming(),
                    template: to_json(&DynamicMessage::new(m.input())).unwrap_or_else(|_| "{}".into()),
                })
                .collect(),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn compile(src: &Source) -> Result<DescriptorPool, String> {
    let mut includes: Vec<std::path::PathBuf> = src.includes.iter().map(Into::into).collect();
    for p in &src.protos {
        if let Some(dir) = std::path::Path::new(p).parent() {
            if !includes.iter().any(|i| i == dir) { includes.push(dir.to_path_buf()); }
        }
    }
    let set = protox::compile(&src.protos, &includes).map_err(|e| format!("Couldn't compile the .proto files: {e}"))?;
    let mut pool = DescriptorPool::new();
    pool.add_file_descriptor_set(set).map_err(|e| e.to_string())?;
    Ok(pool)
}

async fn connect(target: &str) -> Result<Channel, String> {
    let t = target.trim();
    if t.is_empty() { return Err("Enter the server address, e.g. localhost:50051".into()); }
    let tls = t.starts_with("https://") || t.starts_with("grpcs://");
    let url = if let Some(rest) = t.strip_prefix("grpcs://") { format!("https://{rest}") } else if t.contains("://") { t.to_string() } else { format!("http://{t}") };
    let mut ep = Endpoint::from_shared(url.clone()).map_err(|e| format!("Bad address {t}: {e}"))?.connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(120));
    if tls {
        ep = ep.tls_config(ClientTlsConfig::new().with_native_roots()).map_err(|e| format!("TLS setup failed: {e}"))?;
    }
    ep.connect().await.map_err(|e| {
        let mut m = format!("Couldn't connect to {t}: {e}");
        if let Some(src) = std::error::Error::source(&e) { m.push_str(&format!(" ({src})")); }
        m
    })
}

// ---------- reflection ----------

macro_rules! reflect_with {
    ($ns:path, $channel:expr, $host:expr) => {{
        use $ns as r;
        use r::server_reflection_client::ServerReflectionClient;
        use r::server_reflection_request::MessageRequest;
        use r::server_reflection_response::MessageResponse;
        async fn one(client: &mut ServerReflectionClient<Channel>, host: &str, req: MessageRequest) -> Result<MessageResponse, Status> {
            let request = r::ServerReflectionRequest { host: host.to_string(), message_request: Some(req) };
            let mut stream = client.server_reflection_info(tokio_stream::once(request)).await?.into_inner();
            match stream.message().await? {
                Some(r::ServerReflectionResponse { message_response: Some(MessageResponse::ErrorResponse(e)), .. }) => Err(Status::new(tonic::Code::from(e.error_code), e.error_message)),
                Some(r::ServerReflectionResponse { message_response: Some(m), .. }) => Ok(m),
                _ => Err(Status::internal("Empty reflection response")),
            }
        }
        let channel = $channel;
        let host: &str = $host;
        async move {
        let mut client = ServerReflectionClient::new(channel);
        let services = match one(&mut client, host, MessageRequest::ListServices(String::new())).await? {
            MessageResponse::ListServicesResponse(l) => l.service.into_iter().map(|s| s.name).collect::<Vec<_>>(),
            _ => Vec::new(),
        };
        let mut files: HashMap<String, prost_types::FileDescriptorProto> = HashMap::new();
        let mut wanted: Vec<MessageRequest> = services.iter().map(|s| MessageRequest::FileContainingSymbol(s.clone())).collect();
        let mut asked = 0;
        while let Some(req) = wanted.pop() {
            asked += 1;
            if asked > 500 { break; }
            if let MessageResponse::FileDescriptorResponse(fd) = one(&mut client, host, req).await? {
                for bytes in fd.file_descriptor_proto {
                    let f = prost_types::FileDescriptorProto::decode(bytes.as_slice()).map_err(|e| Status::internal(e.to_string()))?;
                    let name = f.name().to_string();
                    for dep in &f.dependency {
                        if !files.contains_key(dep) && !wanted.iter().any(|w| matches!(w, MessageRequest::FileByFilename(n) if n == dep)) {
                            wanted.push(MessageRequest::FileByFilename(dep.clone()));
                        }
                    }
                    files.insert(name, f);
                }
            }
            // Drop requests for files that arrived alongside others.
            wanted.retain(|w| !matches!(w, MessageRequest::FileByFilename(n) if files.contains_key(n)));
        }
        Ok::<Vec<prost_types::FileDescriptorProto>, Status>(files.into_values().collect())
        }.await
    }};
}

async fn reflect(src: &Source) -> Result<DescriptorPool, String> {
    let channel = connect(&src.target).await?;
    let host = src.target.split("://").last().unwrap_or("").to_string();
    let files = match reflect_with!(tonic_reflection::pb::v1, channel.clone(), &host) {
        Ok(f) => f,
        // Older servers only speak v1alpha; neither means no reflection at all.
        Err(s) if s.code() == tonic::Code::Unimplemented => reflect_with!(tonic_reflection::pb::v1alpha, channel, &host).map_err(|s| {
            if s.code() == tonic::Code::Unimplemented { format!("{} doesn't offer server reflection. Load its .proto files instead.", src.target) } else { format!("Server reflection failed: {} ({:?})", s.message(), s.code()) }
        })?,
        Err(s) => return Err(format!("Server reflection failed: {} ({:?})", s.message(), s.code())),
    };
    let mut pool = DescriptorPool::new();
    pool.add_file_descriptor_protos(files).map_err(|e| format!("The server's schema is incomplete: {e}"))?;
    Ok(pool)
}

// ---------- codec for dynamic messages ----------

struct DynCodec {
    output: MessageDescriptor,
}
struct DynEncoder;
struct DynDecoder(MessageDescriptor);

impl Codec for DynCodec {
    type Encode = DynamicMessage;
    type Decode = DynamicMessage;
    type Encoder = DynEncoder;
    type Decoder = DynDecoder;
    fn encoder(&mut self) -> DynEncoder { DynEncoder }
    fn decoder(&mut self) -> DynDecoder { DynDecoder(self.output.clone()) }
}

impl Encoder for DynEncoder {
    type Item = DynamicMessage;
    type Error = Status;
    fn encode(&mut self, item: DynamicMessage, dst: &mut EncodeBuf<'_>) -> Result<(), Status> {
        item.encode(dst).map_err(|e| Status::internal(e.to_string()))
    }
}

impl Decoder for DynDecoder {
    type Item = DynamicMessage;
    type Error = Status;
    fn decode(&mut self, src: &mut DecodeBuf<'_>) -> Result<Option<DynamicMessage>, Status> {
        DynamicMessage::decode(self.0.clone(), src).map(Some).map_err(|e| Status::internal(format!("Couldn't decode the response: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost_reflect::ReflectMessage as _;

    async fn reflection_server() -> String {
        let svc = tonic_reflection::server::Builder::configure()
            .register_encoded_file_descriptor_set(tonic_reflection::pb::v1::FILE_DESCRIPTOR_SET)
            .build_v1()
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(tonic::transport::Server::builder().add_service(svc).serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener)));
        format!("127.0.0.1:{}", addr.port())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reflection_and_dynamic_calls() {
        let target = reflection_server().await;
        let state = GrpcState::default();
        let src = Source { target: target.clone(), protos: vec![], includes: vec![], metadata: vec![("x-trace".into(), "t1".into())] };
        // The reflection service hides itself from the list…
        let services = state.describe(&src).await.unwrap();
        assert!(services.is_empty(), "{services:?}");
        // …but its schema is loaded, so it can be called dynamically (bidi, one message).
        let res = state.call(&src, "grpc.reflection.v1.ServerReflection/ServerReflectionInfo", r#"{"listServices": ""}"#, |_| {}).await.unwrap();
        assert_eq!(res.code_name, "OK", "{res:?}");
        assert_eq!(res.messages.len(), 1);
        assert!(res.messages[0].contains("grpc.reflection.v1.ServerReflection"), "{}", res.messages[0]);
        let bad = state.call(&src, "grpc.reflection.v1.ServerReflection/ServerReflectionInfo", r#"{"nope": 1}"#, |_| {}).await.unwrap_err();
        assert!(bad.contains("doesn't match"), "{bad}");
        assert!(state.call(&src, "x.Y/Z", "{}", |_| {}).await.unwrap_err().contains("No service"));
    }

    #[test]
    fn protos_compile_with_templates() {
        let dir = std::env::temp_dir().join(format!("dispatch-proto-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("shop.proto"), "syntax = \"proto3\";\npackage shop.v1;\nimport \"google/protobuf/timestamp.proto\";\nmessage GetReq { string id = 1; repeated string fields = 2; }\nmessage Order { string id = 1; int64 total = 2; google.protobuf.Timestamp at = 3; }\nservice Orders { rpc Get(GetReq) returns (Order); rpc Watch(GetReq) returns (stream Order); }\n").unwrap();
        let src = Source { target: "localhost:1".into(), protos: vec![dir.join("shop.proto").to_string_lossy().to_string()], includes: vec![], metadata: vec![] };
        let pool = compile(&src).unwrap();
        let services = list(&pool);
        assert_eq!(services.len(), 1);
        assert_eq!(services[0].name, "shop.v1.Orders");
        let get = &services[0].methods[0];
        assert_eq!((get.path.as_str(), get.server_streaming), ("shop.v1.Orders/Get", false));
        assert!(services[0].methods[1].server_streaming);
        assert!(get.template.contains("\"id\": \"\"") && get.template.contains("\"fields\": []"), "{}", get.template);
        let m = parse_json(find_method(&pool, "shop.v1.Orders/Get").unwrap().input(), r#"{"id":"o1"}"#).unwrap();
        let back = DynamicMessage::decode(m.descriptor(), m.encode_to_vec().as_slice()).unwrap();
        assert!(to_json(&back).unwrap().contains("\"o1\""));
        assert!(compile(&Source { protos: vec!["/nope/x.proto".into()], ..src }).unwrap_err().contains("Couldn't compile"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
