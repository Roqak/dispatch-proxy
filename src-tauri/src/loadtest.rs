//! Load tests: many virtual users sending one request over a shared connection
//! pool, with live progress, latency percentiles and a per-second timeline.

use crate::http::{self, OutgoingRequest};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Concurrent virtual users (1–500).
    pub vus: u32,
    /// Stop after this long (seconds), if set.
    #[serde(default)]
    pub duration_s: Option<u64>,
    /// Stop after this many requests, if set.
    #[serde(default)]
    pub requests: Option<u64>,
    /// Start users gradually over this many seconds.
    #[serde(default)]
    pub ramp_up_s: u64,
    /// Cap on requests per second across all users (0 = no cap).
    #[serde(default)]
    pub rps: u64,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Second {
    pub t: u64,
    pub count: u64,
    pub errors: u64,
    pub p95_ms: f64,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub elapsed_ms: u64,
    pub done: u64,
    pub ok: u64,
    pub failed: u64,
    pub rps: f64,
    pub active_vus: u32,
    pub min_ms: f64,
    pub mean_ms: f64,
    pub p50_ms: f64,
    pub p90_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub max_ms: f64,
    pub bytes: u64,
    pub statuses: Vec<(u16, u64)>,
    pub errors: Vec<(String, u64)>,
    pub timeline: Vec<Second>,
    pub finished: bool,
    pub stopped: bool,
}

#[derive(Default)]
struct Stats {
    latencies_us: Vec<u32>,
    statuses: HashMap<u16, u64>,
    errors: HashMap<String, u64>,
    seconds: Vec<(u64, u64, Vec<u32>)>, // (count, errors, latencies) per second
    bytes: u64,
    ok: u64,
    failed: u64,
}

const MAX_SAMPLES: usize = 2_000_000;

fn percentile(sorted: &[u32], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let i = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[i.min(sorted.len() - 1)] as f64 / 1000.0
}

fn report(stats: &Stats, started: Instant, active: u32, finished: bool, stopped: bool) -> Report {
    let mut sorted = stats.latencies_us.clone();
    sorted.sort_unstable();
    let elapsed = started.elapsed();
    let done = stats.ok + stats.failed;
    let mean = if sorted.is_empty() { 0.0 } else { sorted.iter().map(|&x| x as f64).sum::<f64>() / sorted.len() as f64 / 1000.0 };
    let mut statuses: Vec<(u16, u64)> = stats.statuses.iter().map(|(k, v)| (*k, *v)).collect();
    statuses.sort();
    let mut errors: Vec<(String, u64)> = stats.errors.iter().map(|(k, v)| (k.clone(), *v)).collect();
    errors.sort_by(|a, b| b.1.cmp(&a.1));
    errors.truncate(5);
    let timeline = stats
        .seconds
        .iter()
        .enumerate()
        .map(|(t, (count, errs, lat))| {
            let mut l = lat.clone();
            l.sort_unstable();
            Second { t: t as u64, count: *count, errors: *errs, p95_ms: percentile(&l, 95.0) }
        })
        .collect();
    Report {
        elapsed_ms: elapsed.as_millis() as u64,
        done,
        ok: stats.ok,
        failed: stats.failed,
        rps: if elapsed.as_secs_f64() > 0.0 { done as f64 / elapsed.as_secs_f64() } else { 0.0 },
        active_vus: active,
        min_ms: sorted.first().map_or(0.0, |&x| x as f64 / 1000.0),
        mean_ms: (mean * 1000.0).round() / 1000.0,
        p50_ms: percentile(&sorted, 50.0),
        p90_ms: percentile(&sorted, 90.0),
        p95_ms: percentile(&sorted, 95.0),
        p99_ms: percentile(&sorted, 99.0),
        max_ms: sorted.last().map_or(0.0, |&x| x as f64 / 1000.0),
        bytes: stats.bytes,
        statuses,
        errors,
        timeline,
        finished,
        stopped,
    }
}

#[derive(Default)]
pub struct LoadTests {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl LoadTests {
    pub fn stop(&self, id: &str) -> bool {
        match self.running.lock().unwrap_or_else(|p| p.into_inner()).get(id) {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    pub async fn run(&self, id: String, req: OutgoingRequest, cfg: Config, progress: impl Fn(Report) + Send + Sync + 'static) -> Result<Report, String> {
        let vus = cfg.vus.clamp(1, 500);
        let duration = cfg.duration_s.map(|s| Duration::from_secs(s.clamp(1, 3600)));
        let limit = cfg.requests.map(|n| n.clamp(1, 1_000_000));
        if duration.is_none() && limit.is_none() {
            return Err("Set a duration or a number of requests.".into());
        }
        let settings = req.settings.clone().unwrap_or_default();
        let timeout = Duration::from_millis(settings.timeout_ms.max(1));
        let client = http::client_builder(&settings)
            .await?
            .timeout(timeout)
            .pool_max_idle_per_host(vus as usize)
            .build()
            .map_err(|e| format!("Could not set up the HTTP client: {e}"))?;
        // Fail fast on a request that can't be built (bad URL, missing file).
        let _ = http::build_request(&client, &req).await?;

        let stop = Arc::new(AtomicBool::new(false));
        self.running.lock().unwrap_or_else(|p| p.into_inner()).insert(id.clone(), stop.clone());
        let stats = Arc::new(Mutex::new(Stats::default()));
        let issued = Arc::new(AtomicU64::new(0));
        let active = Arc::new(AtomicU64::new(0));
        let started = Instant::now();
        let req = Arc::new(req);
        let ramp = Duration::from_secs(cfg.ramp_up_s.min(3600));
        let rps = cfg.rps;

        let mut tasks = Vec::new();
        for i in 0..vus {
            let (client, req, stats, issued, active, stop) = (client.clone(), req.clone(), stats.clone(), issued.clone(), active.clone(), stop.clone());
            let delay = if vus > 1 { ramp.mul_f64(i as f64 / vus as f64) } else { Duration::ZERO };
            tasks.push(tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                active.fetch_add(1, Ordering::SeqCst);
                loop {
                    if stop.load(Ordering::SeqCst) || duration.is_some_and(|d| started.elapsed() >= d) {
                        break;
                    }
                    let n = issued.fetch_add(1, Ordering::SeqCst);
                    if limit.is_some_and(|l| n >= l) {
                        break;
                    }
                    if rps > 0 {
                        // Request n may start no earlier than n / rps seconds in.
                        let at = started + Duration::from_secs_f64(n as f64 / rps as f64);
                        tokio::time::sleep_until(at.into()).await;
                    }
                    let t0 = Instant::now();
                    let outcome = match http::build_request(&client, &req).await {
                        Ok(b) => match b.send().await {
                            Ok(resp) => {
                                let status = resp.status().as_u16();
                                let size = resp.bytes().await.map(|b| b.len() as u64).unwrap_or(0);
                                Ok((status, size))
                            }
                            Err(e) => Err(short_error(&e)),
                        },
                        Err(e) => Err(e),
                    };
                    let us = t0.elapsed().as_micros().min(u32::MAX as u128) as u32;
                    let sec = started.elapsed().as_secs() as usize;
                    let mut s = stats.lock().unwrap_or_else(|p| p.into_inner());
                    if s.latencies_us.len() < MAX_SAMPLES {
                        s.latencies_us.push(us);
                    }
                    while s.seconds.len() <= sec {
                        s.seconds.push((0, 0, Vec::new()));
                    }
                    let failed = match &outcome {
                        Ok((status, size)) => {
                            *s.statuses.entry(*status).or_default() += 1;
                            s.bytes += size;
                            *status >= 400
                        }
                        Err(msg) => {
                            *s.errors.entry(msg.clone()).or_default() += 1;
                            true
                        }
                    };
                    if failed { s.failed += 1 } else { s.ok += 1 }
                    let slot = &mut s.seconds[sec];
                    slot.0 += 1;
                    if failed {
                        slot.1 += 1;
                    }
                    if slot.2.len() < 50_000 {
                        slot.2.push(us);
                    }
                }
                active.fetch_sub(1, Ordering::SeqCst);
            }));
        }

        // Progress twice a second until every user is done.
        let all = futures_util::future::join_all(tasks);
        tokio::pin!(all);
        loop {
            tokio::select! {
                _ = &mut all => break,
                _ = tokio::time::sleep(Duration::from_millis(500)) => {
                    let r = report(&stats.lock().unwrap_or_else(|p| p.into_inner()), started, active.load(Ordering::SeqCst) as u32, false, false);
                    progress(r);
                }
            }
        }
        self.running.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
        let stopped = stop.load(Ordering::SeqCst);
        let final_report = report(&stats.lock().unwrap_or_else(|p| p.into_inner()), started, 0, true, stopped);
        progress(final_report.clone());
        Ok(final_report)
    }
}

fn short_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "Timed out".into()
    } else if e.is_connect() {
        let mut m = String::from("Couldn't connect");
        if let Some(src) = std::error::Error::source(e) {
            m.push_str(&format!(": {src}"));
        }
        m.chars().take(160).collect()
    } else {
        e.to_string().chars().take(160).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Keep-alive server answering 200, except every 10th request with 500.
    fn server() -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let n = Arc::new(AtomicU64::new(0));
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                let n = n.clone();
                std::thread::spawn(move || {
                    let mut s = s;
                    let mut buf = [0u8; 4096];
                    loop {
                        match s.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {
                                let k = n.fetch_add(1, Ordering::SeqCst);
                                let status = if k % 10 == 9 { "500 Internal Server Error" } else { "200 OK" };
                                if s.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 2\r\n\r\nok").as_bytes()).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                });
            }
        });
        format!("http://{addr}/")
    }

    fn req(url: String) -> OutgoingRequest {
        serde_json::from_value(serde_json::json!({ "method": "GET", "url": url, "headers": [], "body": { "mode": "none" } })).unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn counts_requests_statuses_and_percentiles() {
        let url = server();
        let seen = Arc::new(AtomicU64::new(0));
        let s2 = seen.clone();
        let lt = LoadTests::default();
        let r = lt.run("t".into(), req(url), Config { vus: 8, duration_s: None, requests: Some(200), ramp_up_s: 0, rps: 0 }, move |_| { s2.fetch_add(1, Ordering::SeqCst); }).await.unwrap();
        assert_eq!(r.done, 200);
        assert_eq!(r.failed, 20, "every 10th answer is a 500");
        assert_eq!(r.statuses, vec![(200, 180), (500, 20)]);
        assert!(r.finished && !r.stopped);
        assert!(r.p50_ms <= r.p95_ms && r.p95_ms <= r.p99_ms && r.p99_ms <= r.max_ms);
        assert_eq!(r.bytes, 400);
        assert!(seen.load(Ordering::SeqCst) >= 1, "final progress is reported");
        assert_eq!(r.timeline.iter().map(|s| s.count).sum::<u64>(), 200);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn rate_cap_and_stop() {
        let url = server();
        let lt = Arc::new(LoadTests::default());
        let lt2 = lt.clone();
        let started = Instant::now();
        // 20 rps for 30 s would be 600 requests; stop after ~1 s instead.
        let run = tokio::spawn(async move { lt2.run("s".into(), req(url), Config { vus: 4, duration_s: Some(30), requests: None, ramp_up_s: 0, rps: 20 }, |_| {}).await });
        tokio::time::sleep(Duration::from_millis(1000)).await;
        assert!(lt.stop("s"));
        let r = run.await.unwrap().unwrap();
        assert!(r.stopped);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(r.done >= 15 && r.done <= 26, "about 20 requests in a second at 20 rps, got {}", r.done);
    }

    #[tokio::test]
    async fn errors_are_grouped() {
        let lt = LoadTests::default();
        let r = lt.run("e".into(), req("http://127.0.0.1:1/".into()), Config { vus: 2, duration_s: None, requests: Some(6), ramp_up_s: 0, rps: 0 }, |_| {}).await.unwrap();
        assert_eq!(r.failed, 6);
        assert_eq!(r.errors.len(), 1);
        assert!(r.errors[0].0.starts_with("Couldn't connect"), "{:?}", r.errors);
        assert!(lt.run("x".into(), req("http://127.0.0.1:1/".into()), Config { vus: 1, duration_s: None, requests: None, ramp_up_s: 0, rps: 0 }, |_| {}).await.is_err());
    }
}
