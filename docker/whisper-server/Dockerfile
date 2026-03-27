FROM ubuntu:24.04 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    git \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG WHISPER_TAG=v1.7.3
RUN git clone --depth 1 --branch "${WHISPER_TAG}" https://github.com/ggerganov/whisper.cpp.git /whisper.cpp

WORKDIR /whisper.cpp
RUN cmake -B build -DWHISPER_BUILD_SERVER=ON \
  && cmake --build build --config Release -j "$(nproc)"

ARG WHISPER_MODEL=small
RUN bash ./models/download-ggml-model.sh "${WHISPER_MODEL}"

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /whisper.cpp/build/bin/whisper-server /usr/local/bin/whisper-server
COPY --from=builder /whisper.cpp/models/ /models/

ARG WHISPER_MODEL=small
ENV WHISPER_MODEL=${WHISPER_MODEL}

EXPOSE 8178

ENTRYPOINT ["whisper-server"]
CMD ["--model", "/models/ggml-small.bin", \
     "--host", "0.0.0.0", \
     "--port", "8178", \
     "--threads", "4", \
     "--language", "auto"]
