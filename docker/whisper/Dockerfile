# Multi-stage build for whisper.cpp server
# Builds the whisper-server binary and bundles the small model (~500MB RAM)

FROM ubuntu:22.04 AS builder

RUN apt-get update && apt-get install -y \
    build-essential cmake git \
    && rm -rf /var/lib/apt/lists/*

RUN git clone https://github.com/ggerganov/whisper.cpp.git /whisper
WORKDIR /whisper
RUN cmake -B build && cmake --build build --config Release

# Download the small model during build
RUN bash ./models/download-ggml-model.sh small

FROM ubuntu:22.04

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

COPY --from=builder /whisper/build/bin/whisper-server /usr/local/bin/whisper-server
COPY --from=builder /whisper/models/ggml-small.bin /models/ggml-small.bin

EXPOSE 8080

CMD ["whisper-server", \
     "--model", "/models/ggml-small.bin", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--threads", "4"]
