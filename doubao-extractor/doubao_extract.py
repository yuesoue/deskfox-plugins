#!/usr/bin/env python3
"""
豆包对话内容提取工具
通过 Chrome DevTools Protocol (CDP) 从豆包对话中批量提取消息。

用法:
  python3 doubao_extract.py --chat CHAT_ID [--start "起始文本"] [--end "结束文本"] [--output FILE]

示例:
  python3 doubao_extract.py --chat 28899695618562 --start "我想跟你聊一个" --end "DeskFox 定位一致"
  python3 doubao_extract.py --chat 28899695618562  # 提取全部消息
"""

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

try:
    import websockets
except ImportError:
    print("ERROR: websockets 库未安装，请运行: pip3 install websockets")
    sys.exit(1)

CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CHROME_PROFILE = os.path.expanduser("~/Library/Application Support/Google/Chrome")
DEBUG_PORT = 9222
TEMP_PROFILE = os.path.join(tempfile.gettempdir(), "chrome-doubao-profile")

PROFILE_FILES = [
    "Local State",
    "Default/Preferences",
    "Default/Cookies",
    "Default/Login Data",
    "Default/Web Data",
    "Default/Local Storage",
    "Default/Session Storage",
    "Default/IndexedDB",
]


def copy_profile():
    if os.path.exists(TEMP_PROFILE):
        shutil.rmtree(TEMP_PROFILE)
    os.makedirs(os.path.join(TEMP_PROFILE, "Default"), exist_ok=True)
    for item in PROFILE_FILES:
        src = os.path.join(CHROME_PROFILE, item)
        dst = os.path.join(TEMP_PROFILE, item)
        if os.path.exists(src):
            if os.path.isdir(src):
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(src, dst)


def kill_chrome():
    subprocess.run(["pkill", "-f", "Google Chrome"], capture_output=True)
    time.sleep(3)


def launch_chrome(url=None):
    args = [CHROME_BIN, f"--remote-debugging-port={DEBUG_PORT}", f"--user-data-dir={TEMP_PROFILE}", "--no-first-run", "--no-default-browser-check"]
    if url:
        args.append(url)
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(6)
    return proc


def get_ws_url():
    for _ in range(10):
        try:
            resp = urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json/list", timeout=5)
            tabs = json.loads(resp.read())
            for t in tabs:
                if "doubao.com" in t.get("url", ""):
                    return t["webSocketDebuggerUrl"]
        except Exception:
            pass
        time.sleep(2)
    return None


def fetch_all_messages(ws_url, chat_id):
    import asyncio
    import websockets

    async def _fetch():
        async with websockets.connect(ws_url, max_size=50 * 1024 * 1024) as ws:
            msg_id = 0

            async def evaluate(expr):
                nonlocal msg_id
                msg_id += 1
                await ws.send(json.dumps({"id": msg_id, "method": "Runtime.evaluate", "params": {"expression": expr, "returnByValue": True, "awaitPromise": True}}))
                result = json.loads(await ws.recv())
                val = result.get("result", {}).get("result", {})
                return val.get("value", str(val))

            tab_info = await evaluate("JSON.stringify({web_id: document.cookie.match(/web_id=(\\d+)/)?.[1] || '', device_id: document.cookie.match(/device_id=(\\d+)/)?.[1] || ''})")

            result = await evaluate(f"""
            (async function() {{
                var allMessages = [];
                var anchor = 999999;
                var hasMore = true;
                var pageCount = 0;
                var baseUrl = '/im/chain/single?version_code=20800&language=zh&device_platform=web&aid=497858&real_aid=497858&pkg_type=release_version&device_id=7605093720832804404&pc_version=3.21.6&web_id=7605601094091392538&tea_uuid=7605601094091392538&region=CN&sys_region=CN&samantha_web=1&web_platform=browser&use-olympus-account=1&web_tab_id=0403b6ea-6ae1-4a71-b996-571c55d2541b';
                var headers = {{
                    'Accept': 'application/json, text/plain, */*',
                    'Content-Type': 'application/json; encoding=utf-8',
                    'Agw-Js-Conv': 'str'
                }};

                while (hasMore && pageCount < 200) {{
                    var body = {{
                        cmd: 3100,
                        uplink_body: {{
                            pull_singe_chain_uplink_body: {{
                                conversation_id: '{chat_id}',
                                anchor_index: anchor,
                                conversation_type: 0,
                                direction: 1,
                                limit: 50,
                                ext: {{}},
                                filter: {{index_list: []}},
                                evaluate_ab_params: '',
                                evaluate_common_params: ''
                            }}
                        }},
                        sequence_id: crypto.randomUUID()
                    }};

                    var resp = await fetch(baseUrl, {{
                        method: 'POST',
                        headers: headers,
                        credentials: 'include',
                        body: JSON.stringify(body)
                    }});

                    var data = await resp.json();
                    if (data.status_code !== 0) break;

                    var pullBody = (data.downlink_body || {{}}).pull_singe_chain_downlink_body || {{}};
                    var msgs = pullBody.messages || [];
                    if (msgs.length === 0) break;

                    for (var i = msgs.length - 1; i >= 0; i--) {{
                        allMessages.unshift(msgs[i]);
                    }}

                    hasMore = pullBody.has_more;
                    var indices = msgs.map(m => m.index_in_conv);
                    var oldestIdx = Math.min(...indices);

                    if (hasMore && oldestIdx > 0) {{
                        anchor = oldestIdx - 1;
                    }} else {{
                        hasMore = false;
                    }}
                    pageCount++;
                }}

                var result = allMessages.map(function(m) {{
                    var role = m.user_type === 1 ? 'user' : (m.user_type === 2 ? 'bot' : 'u' + m.user_type);
                    var text = '';
                    if (m.content_block) {{
                        for (var b of m.content_block) {{
                            var c = b.content || {{}};
                            var tb = c.text_block || {{}};
                            if (tb.text) text += tb.text;
                        }}
                    }}
                    if (!text && m.content) {{
                        try {{ text = JSON.parse(m.content).text || ''; }} catch(e) {{ text = String(m.content); }}
                    }}
                    return {{role: role, text: text, idx: m.index_in_conv}};
                }});

                return JSON.stringify({{totalMessages: result.length, pages: pageCount, messages: result}});
            }})()
            """)
            return json.loads(result)

    return asyncio.run(_fetch())


def extract_range(messages, start_text, end_text):
    start_idx = None
    end_idx = None
    for i, m in enumerate(messages):
        if start_text and start_text in m["text"] and start_idx is None:
            start_idx = i
        if end_text and end_text in m["text"]:
            end_idx = i
    if start_idx is None and start_text:
        print(f"WARNING: start marker '{start_text}' not found, starting from beginning")
        start_idx = 0
    if end_idx is None and end_text:
        print(f"WARNING: end marker '{end_text}' not found, ending at last message")
        end_idx = len(messages) - 1
    return messages[start_idx : end_idx + 1]


def format_output(messages):
    lines = []
    for m in messages:
        role_label = "【用户】" if m["role"] == "user" else "【豆包】"
        lines.append(f"{role_label}\n{m['text']}\n")
    return "\n".join(lines)


def cleanup(chrome_proc):
    if chrome_proc:
        chrome_proc.terminate()
        try:
            chrome_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            chrome_proc.kill()
    kill_chrome()
    if os.path.exists(TEMP_PROFILE):
        shutil.rmtree(TEMP_PROFILE, ignore_errors=True)


def relaunch_normal_chrome():
    subprocess.Popen(["open", "-a", "Google Chrome"])


def main():
    parser = argparse.ArgumentParser(description="豆包对话内容提取工具")
    parser.add_argument("--chat", required=True, help="对话 ID (URL 中的数字)")
    parser.add_argument("--start", default=None, help="起始文本标记")
    parser.add_argument("--end", default=None, help="结束文本标记")
    parser.add_argument("--output", default=None, help="输出文件路径 (默认打印到终端)")
    parser.add_argument("--json", action="store_true", help="输出 JSON 格式")
    args = parser.parse_args()

    chrome_proc = None
    try:
        print("1/5 复制 Chrome 配置...")
        copy_profile()

        print("2/5 关闭当前 Chrome...")
        kill_chrome()

        print("3/5 启动调试 Chrome...")
        url = f"https://www.doubao.com/chat/{args.chat}"
        chrome_proc = launch_chrome(url)

        print("4/5 连接并获取对话数据...")
        ws_url = get_ws_url()
        if not ws_url:
            print("ERROR: 无法连接到 Chrome 或找不到豆包标签页")
            print("  提示: 请确认对话 ID 正确，且已登录豆包账号")
            sys.exit(1)

        data = fetch_all_messages(ws_url, args.chat)
        messages = data["messages"]
        print(f"  获取到 {data['totalMessages']} 条消息 ({data['pages']} 页)")

        if args.start or args.end:
            messages = extract_range(messages, args.start, args.end)
            print(f"  提取范围: {len(messages)} 条消息")

        print("5/5 输出结果...")
        if args.json:
            output = json.dumps(messages, ensure_ascii=False, indent=2)
        else:
            output = format_output(messages)

        script_dir = os.path.dirname(os.path.abspath(__file__))
        output_dir = os.path.join(script_dir, "output")
        os.makedirs(output_dir, exist_ok=True)
        ext = ".json" if args.json else ".txt"
        output_path = args.output if args.output else os.path.join(output_dir, f"{args.chat}{ext}")
        with open(output_path, "w") as f:
            f.write(output)
        print(f"  已保存到 {output_path}")

    except KeyboardInterrupt:
        print("\n用户中断")
    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback
        traceback.print_exc()
    finally:
        print("\n清理: 关闭调试 Chrome, 恢复正常 Chrome...")
        cleanup(chrome_proc)
        relaunch_normal_chrome()
        print("完成")


if __name__ == "__main__":
    main()
