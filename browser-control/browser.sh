#!/system/bin/sh
# browser.sh —— 内置浏览器控制入口（带桥接自愈）
# 用法: sh browser.sh <list|open|navigate|click|type|screenshot|back|forward|reload|eval|text|new_tab|close_tab> ...
# 示例:
#   sh browser.sh list
#   sh browser.sh open 'https://example.com'
#   sh browser.sh type '#index-kw' '搜索关键词' --tab <id>
#   sh browser.sh click '#index-bn' --tab <id>
#   sh browser.sh screenshot /sdcard/xxx.png --tab <id>
DIR="$(dirname "$0")"
cd "$DIR" || exit 1
NODE=/data/user/0/com.deepseek.harness/files/payload/runtime/bin/node

# 自愈：若 bridge 未就绪则自动重启
if ! curl -s --max-time 3 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  P="cdp-bridg"
  P="${P}e.js"
  for pid in $(pgrep -f "$P"); do kill "$pid" 2>/dev/null; done
  sleep 1
  nohup "$NODE" cdp-bridge.js 9222 >> bridge.log 2>&1 &
  sleep 2
fi

exec "$NODE" browser.js "$@"