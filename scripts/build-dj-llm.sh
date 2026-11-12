#!/bin/sh
# Builds vendor/dj-llm: a relocatable CPython with pinned mlx and mlx-lm, plus a
# one-file launcher (bin/mlx_lm.server) that the app runs as the DJ script writer.
# Network: python-build-standalone from GitHub releases and wheels from PyPI only.
set -eu

PBS_TAG=20261026
PY_VERSION=3.12.16
PBS_FILE="cpython-${PY_VERSION}+${PBS_TAG}-aarch64-apple-darwin-install_only.tar.gz"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_FILE}"
PBS_SHA256=fbf4afef53c2a6b72bb741bc06d5671a9dfaf87bd84e5aa73ac9b3d0d589f14e
# Bump this when anything below changes; fetch-dj-llm.js compares it with vendor/dj-llm/VERSION.
BUNDLE_VERSION="dj-llm-2 python-3.12.16+20261026 mlx-0.32.4 mlx-lm-0.32.2 macosx_14_0"
MAC_PLATFORM=macosx_14_0_arm64

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TARGET="$ROOT/vendor/dj-llm"
WORK="${LVX_DJ_LLM_BUILD_DIR:-$HOME/.lvx-dev/dj-llm-build}"
STAGE="$WORK/stage"

# Exactly what the tested dev venv runs (mlx-lm 0.32.2 and its dependency closure).
REQUIREMENTS='annotated-doc==0.0.6
annotated-types==0.8.0
anyio==4.16.0
click==8.5.1
filelock==4.2.10
fsspec==2026.9.0
h11==0.16.0
hf-xet==1.8.0
httpcore2==2.16.0
httpx2==2.16.0
huggingface-hub==2.4.0
idna==3.20
jinja2==3.1.6
markdown-it-py==4.3.0
markupsafe==3.0.4
mdurl==0.1.2
mlx==0.32.4
mlx-lm==0.32.2
mlx-metal==0.32.4
numpy==2.5.4
packaging==26.3
protobuf==7.36.2
pydantic==2.14.3
pydantic-core==2.50.4
pygments==2.21.0
pyyaml==6.0.3
regex==2026.11.9
rich==15.0.0
safetensors==0.8.0
sentencepiece==0.2.3
shellingham==1.5.4
tokenizers==0.23.3
tqdm==4.70.1
transformers==5.22.2
truststore==0.10.5
typer==0.29.1
typing-extensions==4.16.0
typing-inspection==0.4.5'

mkdir -p "$WORK"
ARCHIVE="$WORK/$PBS_FILE"
if [ ! -f "$ARCHIVE" ] || [ "$(shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)" != "$PBS_SHA256" ]; then
  echo "Downloading $PBS_FILE"
  curl -fL --retry 3 -o "$ARCHIVE.part" "$PBS_URL"
  mv "$ARCHIVE.part" "$ARCHIVE"
fi
DIGEST=$(shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)
[ "$DIGEST" = "$PBS_SHA256" ] || { echo "Python archive checksum mismatch: $DIGEST" >&2; exit 1; }

rm -rf "$STAGE"; mkdir -p "$STAGE"
tar xzf "$ARCHIVE" -C "$STAGE"   # -> $STAGE/python
PY="$STAGE/python/bin/python3.12"
printf '%s\n' "$REQUIREMENTS" > "$WORK/requirements.txt"
# --no-deps: the list above is the full closure, so nothing unpinned can slip in.
# --platform: the oldest macOS mlx publishes wheels for, whatever Mac builds this, so the
# bundle is the same on CI and runs on macOS 14 and later (pip otherwise picks the newest tag).
env -i PATH=/usr/bin:/bin HOME="$HOME" "$PY" -I -m pip install -q --disable-pip-version-check --no-cache-dir \
  --no-deps --only-binary :all: --platform "$MAC_PLATFORM" --target "$STAGE/python/lib/python3.12/site-packages" \
  --no-compile --index-url https://pypi.org/simple -r "$WORK/requirements.txt"
rm -rf "$STAGE/python/lib/python3.12/site-packages/bin"
env -i PATH=/usr/bin:/bin "$PY" -I -m pip check

P="$STAGE/python"
SITE="$P/lib/python3.12/site-packages"
# Prune what a headless, offline server never loads.
rm -rf "$SITE"/pip "$SITE"/pip-* "$SITE"/setuptools "$SITE"/setuptools-* "$SITE"/_distutils_hack "$SITE"/distutils-precedence.pth
rm -rf "$P"/include "$P"/share "$SITE"/mlx/include "$SITE"/mlx/share
rm -rf "$P"/lib/python3.12/ensurepip "$P"/lib/python3.12/idlelib "$P"/lib/python3.12/tkinter "$P"/lib/python3.12/turtledemo \
  "$P"/lib/python3.12/lib2to3 "$P"/lib/python3.12/pydoc_data "$P"/lib/python3.12/test "$P"/lib/python3.12/unittest/test \
  "$P"/lib/python3.12/config-3.12-darwin "$P"/lib/tcl* "$P"/lib/tk* "$P"/lib/itcl* "$P"/lib/thread* "$P"/lib/pkgconfig
rm -f "$P"/lib/python3.12/lib-dynload/_tkinter*.so "$P"/lib/libtcl* "$P"/lib/libtk*
find "$SITE" -type d \( -name tests -o -name test -o -name testing \) -prune \
  ! -path '*/numpy/testing' ! -path '*/numpy/_core/testing' -exec rm -rf {} +
find "$P" -type d -name __pycache__ -prune -exec rm -rf {} +
find "$P" -type f \( -name '*.pyi' -o -name '*.a' -o -name '*.c' -o -name '*.h' -o -name '*.pxd' \) -delete
# Console scripts carry absolute shebangs of this build machine: only python itself stays.
# The launcher calls python3.12 itself, so no symlink has to survive the app packaging.
find "$P/bin" -mindepth 1 ! -name python3.12 -exec rm -rf {} +
# Byte-code once, hash-checked without mtimes, so the signed app is never written to.
"$PY" -I -m compileall -q -j 0 --invalidation-mode unchecked-hash -s "$STAGE" "$P/lib/python3.12" >/dev/null

mkdir -p "$STAGE/bin"
cat > "$STAGE/bin/mlx_lm.server" <<'EOF'
#!/bin/sh
# LVX in Radio DJ writer: the bundled Python runs mlx_lm.server, isolated from the system.
here=$(cd "$(dirname "$0")" && pwd)
exec "$here/../python/bin/python3.12" -I -B -m mlx_lm.server "$@"
EOF
chmod 755 "$STAGE/bin/mlx_lm.server"
cp "$P/LICENSE"* "$STAGE/" 2>/dev/null || true
cat > "$STAGE/README" <<EOF
DJ script writer for LVX in Radio, built by scripts/build-dj-llm.sh.
Python: $PBS_URL (sha256 $PBS_SHA256), license in python/lib/python3.12/LICENSE.txt.
Packages (PyPI wheels): see requirements.txt. mlx and mlx-lm are MIT licensed.
EOF
cp "$WORK/requirements.txt" "$STAGE/requirements.txt"

# Self-containment: nothing may point at the build machine, Homebrew or a venv.
if grep -rIl -e "$HOME" -e "$WORK" "$STAGE" | grep -v '\.pyc$' | head -5 | grep . ; then
  echo "Absolute build paths left in text files above" >&2; exit 1
fi
if find "$STAGE/bin" "$STAGE/python/bin" -type f -perm -u+x -exec sh -c 'head -c 2 "$1" | grep -q "#!" && head -1 "$1" | grep -v "^#!/bin/sh" | sed "s|^|$1: |"' _ {} \; | grep . ; then
  echo "Scripts with foreign shebangs above" >&2; exit 1
fi
BAD=$(find "$STAGE" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -exec sh -c 'file -b "$1" | grep -q Mach-O && otool -l "$1" | awk "/cmd LC_(LOAD|LOAD_WEAK|REEXPORT)_DYLIB\$/{getline; getline; print \$2}" | grep -Ev "^(@rpath|@loader_path|@executable_path|/usr/lib/|/System/)" | sed "s|^|$1: |"' _ {} \;)
[ -z "$BAD" ] || { echo "Non-relocatable library references:" >&2; echo "$BAD" >&2; exit 1; }
# Ad-hoc sign every Mach-O so the bundle runs as is; electron-builder re-signs inside the app.
find "$STAGE" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -exec sh -c 'file -b "$1" | grep -q Mach-O && codesign --force --sign - "$1" 2>/dev/null' _ {} \; || true

printf '%s\n' "$BUNDLE_VERSION" > "$STAGE/VERSION"
rm -rf "$TARGET"; mkdir -p "$(dirname "$TARGET")"
mv "$STAGE" "$TARGET"
echo "DJ writer bundle ($BUNDLE_VERSION) is in $TARGET ($(du -sh "$TARGET" | cut -f1))"
