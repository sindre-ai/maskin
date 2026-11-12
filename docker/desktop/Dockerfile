# Agent computer desktop: Xvfb + XFCE + Chromium, streamed to a browser via
# x11vnc + noVNC — see README.md. Built and pushed to Docker Hub by
# .github/workflows/desktop-docker.yml; the agent-server pulls `latest` for every
# new desktop (DESKTOP_IMAGE).

# Stage 1: build ffmpeg 8 with the whisper filter (speech to text, whisper.cpp). Debian
# bookworm ships ffmpeg 5.1 (no whisper filter, added in 8.0) and no prebuilt static
# ffmpeg 8 has it enabled, so it is compiled here. Only /out leaves this stage.
# Every input is pinned to an exact version and its sha256, so a rebuild cannot change
# silently. To bump one, change the version and the checksum together.
FROM debian:bookworm-slim AS ffmpeg-build

ARG WHISPER_CPP_VERSION=1.9.5
ARG WHISPER_CPP_SHA256=ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720
ARG FFMPEG_VERSION=8.1.3
ARG FFMPEG_SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
# base.en: about 150 MB on disk, English only. A larger model is a one-line change here
# (small.en is about 470 MB) but every new agent computer then carries it.
ARG WHISPER_MODEL_FILE=ggml-base.en.bin
ARG WHISPER_MODEL_SHA256=a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    pkg-config \
    nasm \
    curl \
    xz-utils \
    ca-certificates \
    libx264-dev \
    libmp3lame-dev \
    libopus-dev \
    libvpx-dev \
    libass-dev \
    libfreetype-dev \
    libfontconfig-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# whisper.cpp as shared libraries (libwhisper, libggml*), installed under /usr/local so
# ffmpeg finds whisper.pc. GGML_NATIVE=OFF: the CI runner that builds the image is not
# the machine that runs it, and a native build can use CPU instructions the target lacks
# (the run then dies with "illegal instruction").
RUN curl -fsSL -o whisper.tar.gz "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${WHISPER_CPP_VERSION}.tar.gz" \
  && echo "${WHISPER_CPP_SHA256}  whisper.tar.gz" | sha256sum -c - \
  && tar xzf whisper.tar.gz \
  && cmake -S "whisper.cpp-${WHISPER_CPP_VERSION}" -B whisper-build \
       -DCMAKE_BUILD_TYPE=Release \
       -DCMAKE_INSTALL_PREFIX=/usr/local \
       -DCMAKE_INSTALL_LIBDIR=lib \
       -DBUILD_SHARED_LIBS=ON \
       -DGGML_NATIVE=OFF \
       -DWHISPER_BUILD_EXAMPLES=OFF \
       -DWHISPER_BUILD_TESTS=OFF \
  && cmake --build whisper-build -j"$(nproc)" \
  && cmake --install whisper-build \
  && ldconfig

# ffmpeg: the codecs a short video needs (H.264, VP9, MP3, Opus) and libass so subtitles
# can be burned in, plus the whisper filter. ffmpeg itself is static; only whisper.cpp
# stays shared. No ffplay and no docs.
RUN curl -fsSL -o ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
  && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
  && tar xJf ffmpeg.tar.xz \
  && cd "ffmpeg-${FFMPEG_VERSION}" \
  && PKG_CONFIG_PATH=/usr/local/lib/pkgconfig ./configure \
       --prefix=/usr/local \
       --enable-gpl \
       --enable-whisper \
       --enable-libx264 \
       --enable-libvpx \
       --enable-libmp3lame \
       --enable-libopus \
       --enable-libass \
       --enable-libfreetype \
       --enable-libfontconfig \
       --disable-ffplay \
       --disable-doc \
  && make -j"$(nproc)" \
  && make install DESTDIR=/out \
  && rm -rf /out/usr/local/include /out/usr/local/lib/pkgconfig /out/usr/local/lib/libav*.a /out/usr/local/lib/libsw*.a

# The model, checked against its sha256.
RUN mkdir -p /out/usr/local/share/whisper \
  && curl -fsSL -o "/out/usr/local/share/whisper/${WHISPER_MODEL_FILE}" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_MODEL_FILE}" \
  && echo "${WHISPER_MODEL_SHA256}  /out/usr/local/share/whisper/${WHISPER_MODEL_FILE}" | sha256sum -c -

# The whisper and ggml shared libraries ffmpeg loads at run time. Copied with cp -a so
# the .so symlinks survive.
RUN mkdir -p /out/usr/local/lib \
  && cp -a /usr/local/lib/libwhisper.so* /usr/local/lib/libggml*.so* /out/usr/local/lib/

# Stage 2: the desktop itself.
FROM debian:bookworm-slim

# xfwm4 (windows) + xfdesktop (wallpaper) + Plank (a macOS-style dock). No XFCE
# session or panel: the dock is the only chrome. --no-install-recommends keeps
# out the screen locker, power manager and other daemons that make no sense on a
# virtual display.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    xfwm4 \
    plank \
    xfdesktop4 \
    xfce4-settings \
    xfconf \
    thunar \
    xfce4-terminal \
    dbus-x11 \
    adwaita-icon-theme \
    fonts-dejavu-core \
    chromium \
    x11vnc \
    novnc \
    websockify \
    xdotool \
    scrot \
    procps \
    sudo \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ffmpeg 8 with the whisper filter, built in the stage above. The run-time libraries
# are the ones ffmpeg was linked against (x264, vpx, mp3lame, opus, libass and its
# font stack) plus libgomp1 for ggml. /out holds ffmpeg, ffprobe, the whisper and ggml
# shared libraries (/usr/local/lib) and the model (/usr/local/share/whisper).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libx264-164 \
    libvpx7 \
    libmp3lame0 \
    libopus0 \
    libass9 \
    libfreetype6 \
    libfontconfig1 \
    libgomp1 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg-build /out/ /
RUN ldconfig

# Smoke test, so a broken ffmpeg fails the build instead of reaching an agent: the
# binaries resolve every library, the whisper filter is listed, and the filter really
# loads the model and runs on one second of silence. The shared libraries missing is the
# usual way this goes wrong, and it only shows when ffmpeg is run, not when it is built.
RUN ! ldd /usr/local/bin/ffmpeg | grep -q 'not found' \
  && ffprobe -version \
  && ffmpeg -hide_banner -filters | grep -E '[[:space:]]whisper[[:space:]]' \
  && ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=16000:cl=mono -t 1 \
       -af "whisper=model=/usr/local/share/whisper/ggml-base.en.bin:language=en" -f null -
ENV WHISPER_MODEL=/usr/local/share/whisper/ggml-base.en.bin

# Everything the person or agent sees runs as an ordinary user, not root: Chromium
# refuses to enable its security sandbox as root. Passwordless sudo means nothing
# that needs administrator rights is out of reach (apt install, system files);
# it is just deliberate (`sudo ...`) instead of the default for every process.
RUN useradd -m -s /bin/bash user \
  && echo 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/user \
  && chmod 0440 /etc/sudoers.d/user

# Chromium flags, set here (not on one command line) so the dock and menu
# launchers get them too. No --no-sandbox: the sandbox is on.
RUN printf '%s\n' \
    'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check"' \
    > /etc/chromium.d/desktop-flags

# Pages open at 67 percent zoom so more of each page fits on the 1920x1080 screen. The
# setting is the profile's default page zoom (log(0.67)/log(1.2) = -2.1966), not a
# device scale factor, so the tab strip and address bar keep their normal size.
# Ctrl+0 returns to this default, not to 100 percent.
RUN mkdir -p /home/user/.config/chromium/Default
COPY chromium/preferences.json /home/user/.config/chromium/Default/Preferences

# Compositor on: Plank needs it for its translucent, rounded dock. It is software
# (xrender) rendering, but the screen is mostly static so the cost is small.
RUN mkdir -p /home/user/.config/xfce4/xfconf/xfce-perchannel-xml \
  && printf '%s\n' \
    '<?xml version="1.0" encoding="UTF-8"?>' \
    '<channel name="xfwm4" version="1.0">' \
    '  <property name="general" type="empty">' \
    '    <property name="use_compositing" type="bool" value="true"/>' \
    '    <property name="show_dock_shadow" type="bool" value="false"/>' \
    '    <property name="workspace_count" type="int" value="1"/>' \
    '  </property>' \
    '</channel>' \
    > /home/user/.config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml

# Clean desktop: a wallpaper, no desktop icons, and a floating dock (browser,
# files, terminal). Pictures come from make-wallpaper.py and make-icons.py.
COPY wallpaper.png /usr/share/backgrounds/maskin.png
COPY icons/ /usr/share/icons/maskin/
# Same file names as the system launchers on purpose: Plank pairs a running window
# with the .desktop file that matches its WM class, and a second launcher with a
# different name would leave every open app with an extra, unlabelled dock icon.
COPY apps/ /usr/share/applications/
COPY xfce/xfce4-desktop.xml /home/user/.config/xfce4/xfconf/xfce-perchannel-xml/
# The right-click desktop menu is built from this file: only the three dock apps.
COPY menus/xfce-applications.menu /etc/xdg/menus/xfce-applications.menu
COPY dock/launchers/ /home/user/.config/plank/dock1/launchers/
COPY dock/theme/ /home/user/.local/share/plank/themes/Maskin/
# Plank reads its settings through GSettings; the keyfile backend needs no dconf.
# The same file seeds the GTK file chooser's size: left alone it opens 1124x822, taller
# than the 1920x1080 screen, so its Open button is off-screen and an agent cannot click it.
COPY dock/keyfile /home/user/.config/glib-2.0/settings/keyfile

# Everything above was written as root; hand the user its home.
RUN chown -R user:user /home/user

COPY entrypoint.sh /entrypoint.sh
COPY desktopd.py /usr/local/bin/desktopd.py
RUN chmod +x /entrypoint.sh /usr/local/bin/desktopd.py

# noVNC web client + WebSocket bridge to the VNC server.
# 6080 = noVNC (humans), 6081 = desktopd control API (agents, via the agent-server).
EXPOSE 6080 6081

ENTRYPOINT ["/entrypoint.sh"]
