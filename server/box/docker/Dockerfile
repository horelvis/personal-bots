# The local box: one Linux container that stands in for the Orgo computer (HQ_BOX=docker).
# Each bot gets its own X display in it (see hq-display); the scripts in server/box/ dress them.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      ca-certificates tzdata python3 python3-gi python3-gi-cairo gir1.2-gtk-3.0 librsvg2-common \
      xvfb x11vnc openbox wmctrl xdotool x11-utils x11-xserver-utils maim \
      dbus dbus-x11 openssl procps socat xterm \
      chromium fonts-inter fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

COPY hq-display /usr/local/bin/hq-display
RUN chmod 0755 /usr/local/bin/hq-display

# The first display is the primary bot's screen; the others start when a bot leases one.
CMD ["hq-display", "serve"]
