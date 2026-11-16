# Autor: Matheus C. Pestana
# Estágio 1: decodificadores que o Debian não empacota (ACARS, VDL2, AIS, RDS, satélites Meteor).
FROM python:3.12-slim-bookworm AS decoders

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake pkg-config git ca-certificates \
    librtlsdr-dev libusb-1.0-0-dev zlib1g-dev libxml2-dev libjansson-dev \
    libglib2.0-dev libsqlite3-dev libsndfile1-dev \
    meson ninja-build libliquid-dev libcurl4-openssl-dev libssl-dev \
    libfftw3-dev libpng-dev libjpeg-dev libtiff-dev libjemalloc-dev libvolk2-dev libnng-dev libzstd-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 -b v2.2.0 https://github.com/szpajder/libacars.git \
    && cmake -S libacars -B libacars/build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build libacars/build -j"$(nproc)" && cmake --install libacars/build && ldconfig
# acarsdec fixa -march=native no CMake: sem isso o binário só roda na CPU de quem compilou (SIGILL, código -4)
RUN git clone --depth 1 -b acarsdec-3.7 https://github.com/TLeconte/acarsdec.git \
    && sed -i "s/ -march=native//" acarsdec/CMakeLists.txt \
    && cmake -S acarsdec -B acarsdec/build -DCMAKE_BUILD_TYPE=Release -Drtl=ON \
    && cmake --build acarsdec/build -j"$(nproc)" && install -m755 acarsdec/build/acarsdec /usr/local/bin/
RUN git clone --depth 1 -b v2.4.0 https://github.com/szpajder/dumpvdl2.git \
    && cmake -S dumpvdl2 -B dumpvdl2/build -DCMAKE_BUILD_TYPE=Release -DRTLSDR=ON -DSOAPYSDR=OFF -DMIRISDR=OFF -DSDRPLAY=OFF -DSDRPLAY3=OFF -DZMQ=OFF -DPROFILING=OFF \
    && cmake --build dumpvdl2/build -j"$(nproc)" && install -m755 dumpvdl2/build/src/dumpvdl2 /usr/local/bin/
# AIS (navios)
RUN git clone --depth 1 -b v0.70 https://github.com/jvde-github/AIS-catcher.git \
    && cmake -S AIS-catcher -B AIS-catcher/build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build AIS-catcher/build -j"$(nproc)" && install -m755 AIS-catcher/build/AIS-catcher /usr/local/bin/
# RDS do FM
RUN git clone --depth 1 -b v1.3.1 https://github.com/windytan/redsea.git \
    && cd redsea && meson setup build --buildtype=release && meson compile -C build \
    && install -m755 build/redsea /usr/local/bin/
# satélites Meteor-M (LRPT): SatDump sem interface gráfica, só o que a estação usa
RUN git clone --depth 1 -b 1.2.2 https://github.com/SatDump/SatDump.git \
    && cmake -S SatDump -B SatDump/build -DCMAKE_BUILD_TYPE=Release -DBUILD_GUI=OFF -DCMAKE_INSTALL_PREFIX=/opt/satdump \
    && cmake --build SatDump/build -j"$(nproc)" && cmake --install SatDump/build

# Estágio 2: a imagem da API
FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    rtl-sdr sox ffmpeg curl ca-certificates \
    rtl-433 multimon-ng \
    libxml2 libjansson4 libglib2.0-0 libsqlite3-0 libsndfile1 libliquid1 libcurl4 \
    libfftw3-single3 libpng16-16 libtiff6 libjpeg62-turbo libjemalloc2 libvolk2.5 libnng1 libzstd1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=decoders /usr/local/lib/libacars-2.so* /usr/local/lib/
COPY --from=decoders /usr/local/bin/acarsdec /usr/local/bin/dumpvdl2 /usr/local/bin/AIS-catcher /usr/local/bin/redsea /usr/local/bin/
COPY --from=decoders /opt/satdump /opt/satdump
# libs do SatDump pelo ldconfig (nada de LD_LIBRARY_PATH global)
RUN echo /opt/satdump/lib > /etc/ld.so.conf.d/satdump.conf && ldconfig \
    && ln -s /opt/satdump/bin/satdump /usr/local/bin/satdump \
    && for b in acarsdec dumpvdl2 AIS-catcher redsea satdump rtl_433 multimon-ng; do \
         ldd "$(command -v $b)" | grep -q "not found" && { echo "faltam libs: $b"; ldd "$(command -v $b)" | grep "not found"; exit 1; } || true; done \
    && dumpvdl2 --version && redsea --version

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
