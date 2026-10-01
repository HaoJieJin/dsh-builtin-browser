#!/system/bin/sh
# start-bridge.sh —— 启动 CDP 桥接服务（Chrome devtools abstract socket → tcp:9222）
# 用法: sh start-bridge.sh
DIR="$(dirname "$0")"
cd "$DIR" || exit 1
NODE=/data/user/0/com.deepseek.harness/files/payload/runtime/bin/node

# 清理旧 bridge 进程
P="cdp-bridg"
P="${P}e.js"
for pid in $(pgrep -f "$P"); do kill "$pid" 2>/dev/null; done
sleep 1

# 启动新 bridge
nohup "$NODE" cdp-bridge.js 9222 >> bridge.log 2>&1 &
sleep 2
if curl -s --max-time 3 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  echo "✅ CDP 桥接服务已就绪: 127.0.0.1:9222"
else
  echo "⚠️ 桥接启动但 /json/version 未响应（Chrome 可能未启动，请先在虚拟屏启动 Chrome）"
  exit 1
fi