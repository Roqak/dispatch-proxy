# dispatch-server — the whole backend in one image. The Postman key is NOT
# baked in: pass POSTMAN_API_KEY (and optionally REQUIRE_AUTH/ADMIN_PASSWORD)
# at runtime.
# Build context must be the server/ directory:
#   docker build -t dispatch-server ./server

FROM rust:1-slim AS build
WORKDIR /build
# Dependencies first: this layer survives source edits.
COPY Cargo.lock Cargo.toml ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src target/release/dispatch-server
COPY src ./src
COPY admin ./admin
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home dispatch
COPY --from=build /build/target/release/dispatch-server /usr/local/bin/dispatch-server
# /data owned by the runtime user so a fresh named volume mounts writable.
# (Bind-mounting a root-owned host dir still won't be writable — use named
# volumes, which Render/Railway provide anyway.)
RUN mkdir -p /data && chown dispatch:dispatch /data
# Render/Railway set PORT (the runtime value overrides this image default);
# plain docker binds 0.0.0.0:8383. LISTEN_ADDR overrides both if set by hand.
# Mount a volume at /data for the SQLite database.
ENV PORT=8383 \
    DB_PATH=/data/dispatch-server.db
VOLUME /data
EXPOSE 8383
USER dispatch
ENTRYPOINT ["/usr/local/bin/dispatch-server"]