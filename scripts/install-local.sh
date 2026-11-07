#!/bin/sh
# Install qwen-code with the llama.cpp fork as its local engine, on macOS or
# Linux, from the two checkouts side by side:
#
#   git clone https://github.com/Cemberk/qwen-code      (branch adaptive-local-inference)
#   git clone https://github.com/Cemberk/llama.cpp      (branch adaptive-moe)
#   cd qwen-code && sh scripts/install-local.sh
#
# It builds qwen-code, builds the fork's llama-server for this machine's GPU
# (the backend /models setup recommends), adds a `qwen` command to
# ~/.local/bin, and sets localModelEngine in ~/.qwen/settings.json.
#
# Environment:
#   LLAMA_DIR       the llama.cpp checkout (default: ../llama.cpp)
#   JOBS            parallel compile jobs (default 4; lower it on 16 GB or less)
#   DOWNLOAD_MODEL  1 to also download the default model (13.7 GB) with hf
#
# Needs Node.js 22 or later, git, CMake and a C++ compiler; the GPU SDK of the
# backend (CUDA Toolkit, Vulkan headers and glslc, or ROCm). /models setup
# lists them for this machine.

set -eu

QWEN_DIR=$(cd "$(dirname "$0")/.." && pwd)
LLAMA_DIR=${LLAMA_DIR:-$QWEN_DIR/../llama.cpp}
JOBS=${JOBS:-4}

step() { printf '\n== %s\n' "$1"; }
fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null || fail 'Node.js 22 or later is needed (nvm install 22).'
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' ||
  fail "Node.js $(node --version) is too old: Node.js 22 or later is needed (nvm use 22)."
command -v git >/dev/null || fail 'git is needed.'
command -v cmake >/dev/null || fail 'CMake is needed (brew install cmake, or your package manager).'
[ -d "$LLAMA_DIR/.git" ] || fail "No llama.cpp checkout at $LLAMA_DIR: clone https://github.com/Cemberk/llama.cpp there, or set LLAMA_DIR."

step "Building qwen-code in $QWEN_DIR"
cd "$QWEN_DIR"
corepack pnpm install --frozen-lockfile
npm run build
npm run bundle

BACKEND=$(node scripts/local-setup.mjs backend)
# One option per line, no spaces in any of them.
CMAKE_ARGS=$(node scripts/local-setup.mjs cmake-args | tr '\n' ' ')

step "Building llama-server in $LLAMA_DIR (backend: $BACKEND, $JOBS jobs)"
cd "$LLAMA_DIR"
if git show-ref --verify --quiet refs/heads/adaptive-moe ||
   git ls-remote --exit-code --heads origin adaptive-moe >/dev/null 2>&1; then
  git checkout adaptive-moe
fi
# shellcheck disable=SC2086 # the options are split on purpose
cmake -B build $CMAKE_ARGS
cmake --build build --config Release --target llama-server -j "$JOBS"
ENGINE="$LLAMA_DIR/build/bin/llama-server"
[ -x "$ENGINE" ] || fail "The build did not produce $ENGINE."

step 'Adding the qwen command'
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/qwen" <<EOF
#!/bin/sh
exec "$(command -v node)" "$QWEN_DIR/dist/cli.js" "\$@"
EOF
chmod +x "$HOME/.local/bin/qwen"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) printf 'Add ~/.local/bin to PATH, for example in ~/.zshrc or ~/.bashrc:\n  export PATH="$HOME/.local/bin:$PATH"\n' ;;
esac

step 'Pointing qwen at the engine'
cd "$QWEN_DIR"
node scripts/local-setup.mjs set-engine "$ENGINE"

if [ "${DOWNLOAD_MODEL:-0}" = 1 ]; then
  step 'Downloading the default model'
  command -v hf >/dev/null || fail 'hf is needed to download models (brew install hf, or pip install -U "huggingface_hub[cli]").'
  hf download unsloth/Qwen3.6-35B-A3B-GGUF Qwen3.6-35B-A3B-UD-IQ3_S.gguf
fi

step 'Done'
cat <<EOF
Run qwen in a project folder. Inside it:
  /models setup   this machine's GPUs, the engine and how it is kept off the network
  /models         the local models; /models download <id> fetches one
  /models plan    how a model runs here; /models bench measures it
EOF
