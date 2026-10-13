#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -t 1 ]]; then
  COLOR_RESET="\033[0m"
  COLOR_DIM="\033[2m"
  COLOR_GREEN="\033[32m"
  COLOR_YELLOW="\033[33m"
  COLOR_RED="\033[31m"
  COLOR_CYAN="\033[36m"
  COLOR_BOLD="\033[1m"
else
  COLOR_RESET=""
  COLOR_DIM=""
  COLOR_GREEN=""
  COLOR_YELLOW=""
  COLOR_RED=""
  COLOR_CYAN=""
  COLOR_BOLD=""
fi

log() {
  echo -e "${COLOR_DIM}[$(date '+%Y-%m-%d %H:%M:%S')]${COLOR_RESET} ${COLOR_GREEN}$*${COLOR_RESET}"
}

log_section() {
  echo -e "${COLOR_DIM}[$(date '+%Y-%m-%d %H:%M:%S')]${COLOR_RESET} ${COLOR_BOLD}${COLOR_CYAN}$*${COLOR_RESET}"
}

warn() {
  echo -e "${COLOR_DIM}[$(date '+%Y-%m-%d %H:%M:%S')]${COLOR_RESET} ${COLOR_YELLOW}$*${COLOR_RESET}"
}

fail() {
  echo -e "${COLOR_DIM}[$(date '+%Y-%m-%d %H:%M:%S')]${COLOR_RESET} ${COLOR_BOLD}${COLOR_RED}Install failed: $*${COLOR_RESET}" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "command not found: $1"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

capture_running_suite_socket_containers() {
  local socket_path="$1"
  RUNNING_SUITE_SOCKET_CONTAINERS=()
  command_exists docker || return 0

  local container_id
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    local mount_sources
    mount_sources="$($PREFIX docker inspect --format '{{range .Mounts}}{{println .Source}}{{end}}' "$container_id" 2>/dev/null || true)"
    if grep -Fxq "$socket_path" <<<"$mount_sources"; then
      RUNNING_SUITE_SOCKET_CONTAINERS+=("$container_id")
    fi
  done < <($PREFIX docker ps --quiet --filter 'label=veydeck.owner=suite')
}

stop_running_suite_socket_containers() {
  if (( ${#RUNNING_SUITE_SOCKET_CONTAINERS[@]} == 0 )); then
    return 0
  fi
  log "stop suite containers bound to the current Agent socket: ${#RUNNING_SUITE_SOCKET_CONTAINERS[@]}"
  $PREFIX docker stop "${RUNNING_SUITE_SOCKET_CONTAINERS[@]}" >/dev/null
}

wait_for_agent_socket() {
  local socket_path="$1"
  for _ in {1..30}; do
    if $PREFIX systemctl is-active --quiet veydeck-agent && $PREFIX test -S "$socket_path"; then
      return 0
    fi
    sleep 1
  done
  fail "veydeck-agent did not create a ready Unix socket within 30 seconds: $socket_path"
}

wait_for_veydeck_listener() {
  local port="$1"
  for _ in {1..30}; do
    if $PREFIX systemctl is-active --quiet veydeck \
      && (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  fail "veydeck did not create a ready HTTPS listener within 30 seconds: 127.0.0.1:${port}"
}

restore_running_suite_socket_containers() {
  if (( ${#RUNNING_SUITE_SOCKET_CONTAINERS[@]} == 0 )); then
    return 0
  fi
  log "restore suite containers with the new Agent socket: ${#RUNNING_SUITE_SOCKET_CONTAINERS[@]}"
  $PREFIX docker start "${RUNNING_SUITE_SOCKET_CONTAINERS[@]}" >/dev/null
}

random_chars() {
  local length="$1"
  local charset="$2"
  local output=""
  local chunk=""
  while (( ${#output} < length )); do
    if command -v openssl >/dev/null 2>&1; then
      chunk="$(openssl rand -base64 96)"
    else
      chunk="$(dd if=/dev/urandom bs=96 count=1 2>/dev/null | base64)"
    fi
    output="${output}$(printf '%s' "$chunk" | LC_ALL=C tr -dc "$charset")"
  done
  printf '%s' "${output:0:length}"
}

validate_safe_entry() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9]{8,32}$ ]] || return 1
  local lower
  lower="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  local prefix
  for prefix in api assets images favicon static public health metrics ws wss robots; do
    [[ "$lower" != "$prefix"* ]] || return 1
  done
  return 0
}

validate_username() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$ ]]
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

prompt_yes_no() {
  local prompt="$1"
  local reply=""
  local formatted_prompt
  formatted_prompt="${COLOR_DIM}[$(date '+%Y-%m-%d %H:%M:%S')]${COLOR_RESET} ${COLOR_CYAN}${prompt}${COLOR_RESET}"
  if [[ -t 0 ]]; then
    echo -ne "${formatted_prompt}" >&2
    read -r reply
  elif [[ -r /dev/tty ]]; then
    echo -ne "${formatted_prompt}" >&2
    read -r reply </dev/tty
  else
    return 1
  fi
  case "$reply" in
    y|Y|yes|YES)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

prompt_yes_no_default_yes() {
  local prompt="$1"
  local reply=""
  local formatted_prompt
  formatted_prompt="${COLOR_DIM}[$(date '+%Y-%m-%d %H:%M:%S')]${COLOR_RESET} ${COLOR_CYAN}${prompt}${COLOR_RESET}"
  if [[ -t 0 ]]; then
    echo -ne "${formatted_prompt}" >&2
    read -r reply
  elif [[ -r /dev/tty ]]; then
    echo -ne "${formatted_prompt}" >&2
    read -r reply </dev/tty
  else
    return 1
  fi
  case "$reply" in
    ""|y|Y|yes|YES)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

read_tty_input() {
  local prompt="$1"
  local reply=""
  local formatted_prompt
  formatted_prompt="${COLOR_DIM}[$(date '+%Y-%m-%d %H:%M:%S')]${COLOR_RESET} ${COLOR_CYAN}${prompt}${COLOR_RESET}"
  if [[ -t 0 ]]; then
    echo -ne "${formatted_prompt}" >&2
    read -r reply
  elif [[ -r /dev/tty ]]; then
    echo -ne "${formatted_prompt}" >&2
    read -r reply </dev/tty
  else
    return 1
  fi
  echo "$reply"
}

read_optional_path() {
  local prompt="$1"
  local default_value="$2"
  local reply
  reply="$(read_tty_input "${prompt}(${default_value}): ")" || echo "${default_value}"
  if [[ -z "$reply" ]]; then
    echo "${default_value}"
    return
  fi
  echo "$reply"
}

detect_lan_ipv4() {
  if command_exists ip; then
    local route_source
    route_source="$(ip route get 223.5.5.5 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)"
    if [[ -n "$route_source" && "$route_source" != "127."* ]]; then
      echo "$route_source"
      return 0
    fi
    route_source="$(ip route get 8.8.8.8 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)"
    if [[ -n "$route_source" && "$route_source" != "127."* ]]; then
      echo "$route_source"
      return 0
    fi
    route_source="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n 1)"
    if [[ -n "$route_source" && "$route_source" != "127."* ]]; then
      echo "$route_source"
      return 0
    fi
  fi
  if command_exists hostname; then
    local host_ip
    host_ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^127\.' | head -n 1)"
    if [[ -n "$host_ip" ]]; then
      echo "$host_ip"
      return 0
    fi
  fi
  echo "127.0.0.1"
}

read_default_callback_host() {
  local default_host="$1"
  local port="$2"
  local reply
  local prompt
  echo -e "${COLOR_DIM}[$(date '+%Y-%m-%d %H:%M:%S')] default callback URL preview: https://${default_host}:${port}${COLOR_RESET}" >&2
  prompt="Default controller callback host (${default_host}): "
  reply="$(read_tty_input "$prompt")" || echo "$default_host"
  if [[ -z "$reply" ]]; then
    echo "$default_host"
    return
  fi
  echo "$reply"
}

validate_callback_host() {
  local host="$1"
  [[ -n "$host" ]] || fail "default callback host cannot be empty"
  [[ "$host" != *"://"* ]] || fail "default callback host must be an IP or domain, without scheme"
  [[ "$host" != *"/"* ]] || fail "default callback host must not include path"
  [[ "$host" != *":"* ]] || fail "default callback host must not include port"
}

normalize_abs_path() {
  local path="$1"
  [[ -n "$path" ]] || fail "path cannot be empty"
  [[ "$path" == /* ]] || fail "path must be absolute: $path"
  while [[ "$path" != "/" && "$path" == */ ]]; do
    path="${path%/}"
  done
  echo "$path"
}

# 从现有 systemd 服务或默认目录标记读取安装目录。
detect_existing_veydeck_home() {
  local unit
  local detected_home
  for unit in /etc/systemd/system/veydeck.service /etc/systemd/system/veydeck-agent.service; do
    [[ -f "$unit" ]] || continue
    detected_home="$(sed -n 's/^[[:space:]]*Environment=VEYDECK_HOME=//p' "$unit" | tail -n 1)"
    if [[ -n "$detected_home" ]]; then
      printf '%s' "$detected_home"
      return 0
    fi
  done
  if [[ -f /opt/veydeck/config/agent.install_dir ]]; then
    $PREFIX cat /opt/veydeck/config/agent.install_dir | head -n 1
    return 0
  fi
  return 1
}

# 读取覆盖安装需要复用的监听与回调配置。
load_existing_runtime_config() {
  local path="${VEYDECK_CONFIG_DIR}/runtime-listen.json"
  local content
  local existing_host
  local existing_port
  local existing_public_host
  [[ -f "$path" ]] || fail "existing runtime config not found: $path"
  content="$($PREFIX cat "$path")" || fail "failed to read existing runtime config: $path"
  existing_host="$(printf '%s\n' "$content" | sed -nE 's/.*"host"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' | head -n 1)"
  existing_port="$(printf '%s\n' "$content" | sed -nE 's/.*"port"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' | head -n 1)"
  existing_public_host="$(printf '%s\n' "$content" | sed -nE 's/.*"publicHost"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' | head -n 1)"
  [[ -n "$existing_host" ]] || fail "existing runtime config has no valid host: $path"
  [[ "$existing_port" =~ ^[0-9]+$ ]] || fail "existing runtime config has no valid port: $path"
  if (( existing_port < 1 || existing_port > 65535 )); then
    fail "existing runtime config port must be in range 1-65535: $existing_port"
  fi
  if [[ -n "$existing_public_host" ]]; then
    validate_callback_host "$existing_public_host"
  fi
  if [[ "$VEYDECK_HOST_FROM_ARG" != "true" ]]; then
    VEYDECK_HOST="$existing_host"
  fi
  if [[ "$VEYDECK_PORT_FROM_ARG" != "true" ]]; then
    VEYDECK_PORT="$existing_port"
  fi
  if [[ "$VEYDECK_PUBLIC_HOST_FROM_ARG" != "true" ]]; then
    VEYDECK_PUBLIC_HOST="$existing_public_host"
  fi
}

is_firewalld_active() {
  if ! command_exists firewall-cmd; then
    return 1
  fi
  if systemctl is-active --quiet firewalld 2>/dev/null; then
    return 0
  fi
  return 1
}

is_ufw_active() {
  if ! command_exists ufw; then
    return 1
  fi
  ufw status 2>/dev/null | grep -q "^Status: active"
}

open_port_firewalld() {
  local prefix="$1"
  local port="$2"
  ${prefix} firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null
  ${prefix} firewall-cmd --reload >/dev/null
}

open_port_ufw() {
  local prefix="$1"
  local port="$2"
  ${prefix} ufw allow "${port}/tcp" >/dev/null
}

maybe_open_firewall_port() {
  local prefix="$1"
  local port="$2"
  local handled="false"

  if is_firewalld_active; then
    handled="true"
    warn "firewalld is active. Veydeck port ${port}/tcp may be blocked."
    if prompt_yes_no "Open ${port}/tcp in firewalld now? [y/N] "; then
      if open_port_firewalld "$prefix" "$port"; then
        log "firewalld rule added: ${port}/tcp"
      else
        warn "failed to add firewalld rule for ${port}/tcp"
      fi
    else
      warn "skip firewall change for firewalld"
    fi
  fi

  if is_ufw_active; then
    handled="true"
    warn "ufw is active. Veydeck port ${port}/tcp may be blocked."
    if prompt_yes_no "Open ${port}/tcp in ufw now? [y/N] "; then
      if open_port_ufw "$prefix" "$port"; then
        log "ufw rule added: ${port}/tcp"
      else
        warn "failed to add ufw rule for ${port}/tcp"
      fi
    else
      warn "skip firewall change for ufw"
    fi
  fi

  if [[ "$handled" != "true" ]]; then
    log "no active firewalld/ufw detected"
  fi
}

port_in_use() {
  local port="$1"
  if command_exists ss; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -E -q "(^|[:.])${port}$"
    return $?
  fi
  if command_exists netstat; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -E -q "(^|[:.])${port}$"
    return $?
  fi
  if command_exists lsof; then
    lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null | grep -E -q "[:.]${port}[[:space:]]"
    return $?
  fi
  warn "ss/netstat/lsof not found, skip port conflict check"
  return 1
}

sudo_prefix() {
  if [[ "$(id -u)" -eq 0 ]]; then
    echo ""
    return
  fi
  if command -v sudo >/dev/null 2>&1; then
    echo "sudo"
    return
  fi
  fail "root privileges or sudo are required"
}

VEYDECK_HOST="::"
VEYDECK_HOST_FROM_ARG="false"
VEYDECK_PORT="7310"
VEYDECK_PORT_FROM_ARG="false"
VEYDECK_PUBLIC_HOST=""
VEYDECK_PUBLIC_HOST_FROM_ARG="false"
VEYDECK_HOME="/opt/veydeck"
PREFIX="$(sudo_prefix)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --veydeck-host)
      [[ $# -ge 2 ]] || fail "missing value for --veydeck-host"
      VEYDECK_HOST="$2"
      VEYDECK_HOST_FROM_ARG="true"
      shift 2
      ;;
    --veydeck-port)
      [[ $# -ge 2 ]] || fail "missing value for --veydeck-port"
      VEYDECK_PORT="$2"
      VEYDECK_PORT_FROM_ARG="true"
      shift 2
      ;;
    --veydeck-public-host)
      [[ $# -ge 2 ]] || fail "missing value for --veydeck-public-host"
      VEYDECK_PUBLIC_HOST="$2"
      VEYDECK_PUBLIC_HOST_FROM_ARG="true"
      shift 2
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

# Check if already installed before any user prompts
installed="false"
EXISTING_VEYDECK_HOME=""
if [[ -f "/etc/systemd/system/veydeck.service" || -f "/etc/systemd/system/veydeck-agent.service" ]]; then
  installed="true"
elif [[ -f "/opt/veydeck/config/node.role" ]]; then
  installed="true"
fi

if [[ "$installed" == "true" ]]; then
  EXISTING_VEYDECK_HOME="$(detect_existing_veydeck_home)" || fail "failed to detect the existing Veydeck installation directory"
  if ! prompt_yes_no "Veydeck installation or service was detected. Overwrite existing installation? (y/N): "; then
    log "Installation cancelled."
    exit 0
  fi
fi

if [[ "$installed" == "true" ]]; then
  VEYDECK_HOME="$(normalize_abs_path "$EXISTING_VEYDECK_HOME")"
else
  if [[ "$VEYDECK_PORT_FROM_ARG" != "true" ]]; then
    while true; do
      INPUT_VEYDECK_PORT="$(read_tty_input "Use default Veydeck port (${VEYDECK_PORT})? : ")" || fail "failed to read port input"
      if [[ -z "$INPUT_VEYDECK_PORT" ]]; then
        break
      fi
      if [[ "$INPUT_VEYDECK_PORT" =~ ^[0-9]+$ ]] && (( INPUT_VEYDECK_PORT >= 1 && INPUT_VEYDECK_PORT <= 65535 )); then
        VEYDECK_PORT="$INPUT_VEYDECK_PORT"
        break
      fi
      warn "invalid port: $INPUT_VEYDECK_PORT, expected 1-65535"
    done
  fi

  if [[ "$VEYDECK_PUBLIC_HOST_FROM_ARG" != "true" ]]; then
    DETECTED_VEYDECK_PUBLIC_HOST="$(detect_lan_ipv4)"
    VEYDECK_PUBLIC_HOST="$(read_default_callback_host "$DETECTED_VEYDECK_PUBLIC_HOST" "$VEYDECK_PORT")"
  fi
  VEYDECK_HOME="$(normalize_abs_path "$(read_optional_path "Installation directory" "$VEYDECK_HOME")")"
fi

VEYDECK_CONFIG_DIR="${VEYDECK_HOME}/config"
VEYDECK_DB_DIR="${VEYDECK_HOME}/database"
VEYDECK_LOG_DIR="${VEYDECK_HOME}/logs"
VEYDECK_RUN_DIR="${VEYDECK_HOME}/run"
VEYDECK_AGENT_SOCKET="${VEYDECK_RUN_DIR}/veydeck-agent.sock"
RUNNING_SUITE_SOCKET_CONTAINERS=()

if [[ "$installed" == "true" ]]; then
  load_existing_runtime_config
  log "reuse existing installation directory: ${VEYDECK_HOME}"
  log "reuse existing runtime config: ${VEYDECK_HOST}:${VEYDECK_PORT}"
fi

if ! [[ "$VEYDECK_PORT" =~ ^[0-9]+$ ]]; then
  fail "Veydeck port must be numeric: $VEYDECK_PORT"
fi
if (( VEYDECK_PORT < 1 || VEYDECK_PORT > 65535 )); then
  fail "Veydeck port must be in range 1-65535: $VEYDECK_PORT"
fi

if [[ -n "$VEYDECK_PUBLIC_HOST" ]]; then
  validate_callback_host "$VEYDECK_PUBLIC_HOST"
elif [[ "$installed" != "true" || "$VEYDECK_PUBLIC_HOST_FROM_ARG" == "true" ]]; then
  fail "default callback host cannot be empty"
fi
PRESERVE_EXISTING_SECURITY="false"
if [[ -s "${VEYDECK_DB_DIR}/veydeck.db" ]]; then
  PRESERVE_EXISTING_SECURITY="true"
fi

ADMIN_USERNAME=""
ADMIN_PASSWORD=""
SAFE_ENTRY=""
if [[ "$PRESERVE_EXISTING_SECURITY" != "true" ]]; then
  DEFAULT_ADMIN_USERNAME="veydeck"
  DEFAULT_ADMIN_PASSWORD="$(random_chars 16 'A-Za-z0-9!@#$%^&*')"
  DEFAULT_SAFE_ENTRY="$(random_chars 16 'A-Za-z0-9')"

  ADMIN_USERNAME="$(read_tty_input "Admin username [${DEFAULT_ADMIN_USERNAME}]: ")" || ADMIN_USERNAME=""
  if [[ -z "$ADMIN_USERNAME" ]]; then
    ADMIN_USERNAME="$DEFAULT_ADMIN_USERNAME"
  fi
  validate_username "$ADMIN_USERNAME" || fail "Admin username must be 1-64 characters and contain only letters, digits, underscore, or hyphen"

  ADMIN_PASSWORD="$(read_tty_input "Admin password [generated]: ")" || ADMIN_PASSWORD=""
  if [[ -z "$ADMIN_PASSWORD" ]]; then
    ADMIN_PASSWORD="$DEFAULT_ADMIN_PASSWORD"
  fi
  [[ -n "$ADMIN_PASSWORD" ]] || fail "Admin password must not be empty"
  ((${#ADMIN_PASSWORD} >= 5)) || fail "Admin password must be at least 5 characters"

  SAFE_ENTRY="$(read_tty_input "Safe login entry [${DEFAULT_SAFE_ENTRY}]: ")" || SAFE_ENTRY=""
  if [[ -z "$SAFE_ENTRY" ]]; then
    SAFE_ENTRY="$DEFAULT_SAFE_ENTRY"
  fi
  validate_safe_entry "$SAFE_ENTRY" || fail "Safe entry must be 8-32 ASCII letters or digits and must not use a reserved path prefix"
fi

if [[ "$installed" == "true" ]]; then
  capture_running_suite_socket_containers "$VEYDECK_AGENT_SOCKET"
  stop_running_suite_socket_containers
  log "Stopping existing Veydeck services for overwrite..."
  $PREFIX systemctl stop veydeck-agent >/dev/null 2>&1 || true
  $PREFIX systemctl stop veydeck >/dev/null 2>&1 || true
fi

if port_in_use "$VEYDECK_PORT"; then
  fail "Veydeck port is already in use: $VEYDECK_PORT"
fi

log_section "== Veydeck install started"
log "system: $(uname -s) $(uname -m)"
if [[ -f /etc/os-release ]]; then
  OS_NAME="$(. /etc/os-release && echo "${PRETTY_NAME:-}")"
  if [[ -n "$OS_NAME" ]]; then
    log "distro: $OS_NAME"
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  warn "Docker not detected"
  if prompt_yes_no "Try to install Docker? [y/N] "; then
    warn "Docker auto-install is not implemented yet"
    fail "please install Docker manually and retry"
  else
    warn "continue without Docker"
  fi
else
  DOCKER_VERSION="$(docker --version 2>/dev/null || true)"
  if [[ -n "$DOCKER_VERSION" ]]; then
    log "Docker installed: $DOCKER_VERSION"
  else
    log "Docker installed"
  fi
fi

log "checking systemd..."
require_cmd systemctl
log "checking tar..."
require_cmd tar
# PREFIX was initialized above
log "checking firewall status..."
maybe_open_firewall_port "$PREFIX" "$VEYDECK_PORT"

install_from_tarball() {
  local component="$1"  # "controller" or "agent"
  local name="$2"       # "veydeck" or "veydeck-agent"
  local tarball
  if [[ "$component" == "agent" ]]; then
    tarball="$(find "$SCRIPT_DIR" -maxdepth 1 -type f -name "veydeck-agent-*.tar.gz" | sort | head -n 1)"
  else
    tarball="$(
      find "$SCRIPT_DIR" -maxdepth 1 -type f \
        -name "veydeck-*.tar.gz" \
        ! -name "veydeck-agent-*.tar.gz" \
        ! -name "veydeck-[0-9]*.tar.gz" \
        | sort \
        | head -n 1
    )"
  fi
  [[ -n "$tarball" && -f "$tarball" ]] || fail "missing component package for $component"

  local temp_bin_dir
  temp_bin_dir="$(mktemp -d)"
  tar -xzf "$tarball" -C "$temp_bin_dir"

  local source="$temp_bin_dir/$name"
  local target="/usr/local/bin/$name"
  local link="/usr/bin/$name"
  [[ -x "$source" ]] || { rm -rf "$temp_bin_dir"; fail "missing binary in package: $name"; }
  $PREFIX install -m 0755 "$source" "$target"
  $PREFIX ln -sf "$target" "$link"
  rm -rf "$temp_bin_dir"
}

write_file_if_missing() {
  local path="$1"
  local content="$2"
  if [[ -f "$path" ]]; then
    return
  fi
  printf '%b' "$content" | $PREFIX tee "$path" >/dev/null
}

write_service() {
  local name="$1"
  local template="$SCRIPT_DIR/templates/$name.service"
  local target="/etc/systemd/system/$name.service"
  [[ -f "$template" ]] || fail "missing service template: $template"
  local content
  content="$(<"$template")"
  content="${content//__VEYDECK_HOME__/${VEYDECK_HOME}}"
  printf '%s\n' "$content" | $PREFIX tee "$target" >/dev/null
  $PREFIX chmod 0644 "$target"
}

run_veydeck_init_runtime_config() {
  if [[ -n "$PREFIX" ]]; then
    $PREFIX env \
      VEYDECK_HOME="$VEYDECK_HOME" \
      VEYDECK_CONFIG_DIR="$VEYDECK_CONFIG_DIR" \
      VEYDECK_DB_DIR="$VEYDECK_DB_DIR" \
      VEYDECK_LOG_DIR="$VEYDECK_LOG_DIR" \
      VEYDECK_AGENT_SOCKET="$VEYDECK_AGENT_SOCKET" \
      RUST_LOG=error \
      /usr/local/bin/veydeck init-runtime-config --host "$VEYDECK_HOST" --port "$VEYDECK_PORT" --public-host "$VEYDECK_PUBLIC_HOST" >/dev/null
  else
    VEYDECK_HOME="$VEYDECK_HOME" \
      VEYDECK_CONFIG_DIR="$VEYDECK_CONFIG_DIR" \
      VEYDECK_DB_DIR="$VEYDECK_DB_DIR" \
      VEYDECK_LOG_DIR="$VEYDECK_LOG_DIR" \
      VEYDECK_AGENT_SOCKET="$VEYDECK_AGENT_SOCKET" \
      RUST_LOG=error \
      /usr/local/bin/veydeck init-runtime-config --host "$VEYDECK_HOST" --port "$VEYDECK_PORT" --public-host "$VEYDECK_PUBLIC_HOST" >/dev/null
  fi
}

log "prepare directories under ${VEYDECK_HOME}"
$PREFIX mkdir -p "$VEYDECK_CONFIG_DIR" "$VEYDECK_DB_DIR" "$VEYDECK_LOG_DIR" "$VEYDECK_RUN_DIR"

if [[ "$PRESERVE_EXISTING_SECURITY" != "true" ]]; then
  log "write bootstrap security file: ${VEYDECK_CONFIG_DIR}/bootstrap-security.json"
  BOOTSTRAP_SECURITY_JSON="$(
    printf '{"username":"%s","password":"%s","safe_entry":"%s","password_complexity":false}\n' \
      "$(json_escape "$ADMIN_USERNAME")" \
      "$(json_escape "$ADMIN_PASSWORD")" \
      "$(json_escape "$SAFE_ENTRY")"
  )"
  printf '%s' "$BOOTSTRAP_SECURITY_JSON" | $PREFIX tee "$VEYDECK_CONFIG_DIR/bootstrap-security.json" >/dev/null
  $PREFIX chmod 0600 "$VEYDECK_CONFIG_DIR/bootstrap-security.json"
else
  log "preserve existing administrator and security settings"
fi

log_section "== install agent"
log "install binary: /usr/local/bin/veydeck-agent"
install_from_tarball "agent" "veydeck-agent"

log "write config: ${VEYDECK_CONFIG_DIR}/agent.toml"
write_file_if_missing "$VEYDECK_CONFIG_DIR/agent.toml" "# veydeck agent config\n"
log "write install dir marker: ${VEYDECK_CONFIG_DIR}/agent.install_dir"
write_file_if_missing "$VEYDECK_CONFIG_DIR/agent.install_dir" "$VEYDECK_HOME"
log "write node role: ${VEYDECK_CONFIG_DIR}/node.role"
printf '%s\n' "all" | $PREFIX tee "$VEYDECK_CONFIG_DIR/node.role" >/dev/null

log "write service: /etc/systemd/system/veydeck-agent.service"
write_service "veydeck-agent"
log "agent service prepared; it will start after Veydeck is ready"

log_section "== install veydeck"
log "install binary: /usr/local/bin/veydeck"
install_from_tarball "controller" "veydeck"
if [[ -x "$SCRIPT_DIR/veydeckctl" ]]; then
  log "install tool: /usr/local/bin/veydeckctl"
  $PREFIX install -m 0755 "$SCRIPT_DIR/veydeckctl" /usr/local/bin/veydeckctl
  $PREFIX ln -sf /usr/local/bin/veydeckctl /usr/bin/veydeckctl
fi

if command -v openssl >/dev/null 2>&1; then
  JWT_SECRET="$(openssl rand -hex 24)"
else
  JWT_SECRET="veydeck_dev_jwt_secret"
fi

log "write config: ${VEYDECK_CONFIG_DIR}/veydeck.toml"
write_file_if_missing "$VEYDECK_CONFIG_DIR/veydeck.toml" "jwtSecret = \"$JWT_SECRET\"\nagentBinary = \"/usr/local/bin/veydeck-agent\"\nveydeckctlPath = \"/usr/local/bin/veydeckctl\"\n"
if [[ "$installed" != "true" || "$VEYDECK_HOST_FROM_ARG" == "true" || "$VEYDECK_PORT_FROM_ARG" == "true" || "$VEYDECK_PUBLIC_HOST_FROM_ARG" == "true" ]]; then
  log "init Veydeck listen config: ${VEYDECK_HOST}:${VEYDECK_PORT}"
  if [[ -n "$VEYDECK_PUBLIC_HOST" ]]; then
    log "default controller callback URL: https://${VEYDECK_PUBLIC_HOST}:${VEYDECK_PORT}"
  fi
  run_veydeck_init_runtime_config
else
  log "preserve existing Veydeck listen and callback config"
fi

log "write service: /etc/systemd/system/veydeck.service"
write_service "veydeck"
log "start service: veydeck"
$PREFIX systemctl daemon-reload
$PREFIX systemctl enable --now veydeck >/dev/null 2>&1
wait_for_veydeck_listener "$VEYDECK_PORT"
log "veydeck service started"

log "start service: veydeck-agent"
$PREFIX systemctl enable --now veydeck-agent >/dev/null 2>&1
wait_for_agent_socket "$VEYDECK_AGENT_SOCKET"
log "agent service started"
restore_running_suite_socket_containers

log_section "== install completed"
if [[ "$PRESERVE_EXISTING_SECURITY" != "true" ]]; then
  echo "Veydeck initial login information:"
  echo
  echo "  Username: ${ADMIN_USERNAME}"
  echo "  Password: ${ADMIN_PASSWORD}"
  echo "  URL     : https://${VEYDECK_PUBLIC_HOST}:${VEYDECK_PORT}/${SAFE_ENTRY}"
  echo
  echo "Please save the password now. veydeckctl can reset the password but cannot display it later."
else
  echo "Existing administrator credentials and security settings were preserved."
fi
