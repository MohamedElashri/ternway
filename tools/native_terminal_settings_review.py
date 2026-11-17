"""Native terminal settings and OSC 52 checks against the isolated GUI harness."""
import base64
import shlex
import time


def run(h):
    path = h['root'] / 'config' / 'ternway' / 'config'
    original = path.read_text()
    # The smoke harness owns this config and shell; never use a user's config.
    base = '\n'.join(line for line in original.splitlines()
                     if line.partition('=')[0].strip() not in {
                         'clipboard-read', 'clipboard-write', 'copy-on-select',
                         'title', 'window-width', 'window-height'}) + '\ncopy-on-select = false\n'
    sequence = 0

    def output_has(text):
        return h['read']("return [...document.querySelectorAll('.terminal-host:not([hidden]) .ghostty-accessibility')].some(el=>el.textContent.includes(arguments[0]));", text)

    def program(code, ready):
        encoded = base64.b64encode(code.encode()).decode()
        # Paste only the single-line fixture command, then send a real Enter.
        # Per-character WebDriver typing becomes very slow after the output flood.
        command = 'python3 -c ' + shlex.quote(f"import base64;exec(base64.b64decode('{encoded}'))")
        h['execute']("const el=document.querySelector('.terminal-host:not([hidden]) .ghostty-input');const data=new DataTransfer();data.setData('text/plain',arguments[0]);el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));", command)
        h['request']('POST', f"/session/{h['session']}/actions", {'actions': [{'type': 'key', 'id': 'settings-program-enter', 'actions': [{'type': 'keyDown', 'value': '\ue007'}, {'type': 'keyUp', 'value': '\ue007'}]}]})
        h['wait'](lambda: output_has(ready), ready)

    def settings(extra):
        nonlocal sequence
        sequence += 1
        title = f'CI terminal settings {sequence}'
        path.write_text(base + extra + f'\ntitle = {title}\n')
        h['wait'](lambda: h['invoke']('plugin:window|title', label='main') == title,
                  'saved terminal settings apply to native window')

    def clipboard_program(payload, marker):
        program(f"import os;os.write(1,{payload!r});print({marker!r},flush=True)", marker)

    try:
        settings('')
        h['invoke']('write_clipboard_text', text='CI_DEFAULT_CLIPBOARD')
        clipboard_program(b'\x1b]52;c;dW5hdXRob3JpemVk\x07', 'CI_DEFAULT_OSC52_FINISHED')
        assert h['invoke']('read_clipboard_text') == 'CI_DEFAULT_CLIPBOARD'
        h['check']('default terminal clipboard policy leaves OSC52 writes inert')

        settings('clipboard-read = deny\nclipboard-write = deny\nwindow-width = 100\nwindow-height = 30\n')
        time.sleep(.2)
        size = h['invoke']('plugin:window|inner_size', label='main')
        assert size['width'] >= 640 and size['height'] >= 480
        # A title change is unrelated to geometry and must not resize the window.
        settings('clipboard-read = deny\nclipboard-write = deny\nwindow-width = 100\nwindow-height = 30\nfont-size = 14\n')
        assert h['invoke']('plugin:window|inner_size', label='main') == size
        h['check']('native window title and configured geometry apply; unrelated settings retain window size')

        settings('clipboard-read = allow\nclipboard-write = allow\n')
        expected = 'CI_OSC52_ORDERED_é'
        encoded = base64.b64encode(expected.encode())
        payload = b'\x1b]52;c;' + encoded + b'\x07\x1b]52;c;?\x07'
        program(f'''import os,select,termios,tty
old=termios.tcgetattr(0);tty.setraw(0)
try:
 os.write(1,{payload!r});data=b''
 while not data.endswith(b'\\x07'):
  if not select.select([0],[],[],5)[0]:raise RuntimeError('OSC52 response timeout')
  data+=os.read(0,65536)
 os.write(1,b'\\r\\nCI_OSC52_REPLY_'+data.hex().encode()+b'\\r\\n')
finally:termios.tcsetattr(0,termios.TCSANOW,old)
''', 'CI_OSC52_REPLY_')
        response = b'\x1b]52;c;' + encoded + b'\x07'
        assert output_has('CI_OSC52_REPLY_' + response.hex())
        assert h['invoke']('read_clipboard_text') == expected
        h['check']('coalesced OSC52 write then query preserves order and returns UTF8 clipboard data to the real PTY')

        settings('copy-on-select = clipboard\nclick-repeat-interval = 500\n')
        program("import os;os.write(1,b'\\x1b[2J\\x1b[HWORD_SETTINGS\\r\\nCI_SELECTION_READY\\r\\n')", 'CI_SELECTION_READY')
        point = h['read']("const c=document.querySelector('.terminal-host:not([hidden]) canvas'),r=c.getBoundingClientRect();return {x:Math.round(r.left+20),y:Math.round(r.top+5)};")
        def double_click():
            h['request']('POST', f"/session/{h['session']}/actions", {'actions': [{'type': 'pointer', 'id': 'settings-selection', 'parameters': {'pointerType': 'mouse'}, 'actions': [
                {'type': 'pointerMove', 'x': point['x'], 'y': point['y']}, {'type': 'pointerDown', 'button': 0}, {'type': 'pointerUp', 'button': 0},
                {'type': 'pause', 'duration': 100}, {'type': 'pointerDown', 'button': 0}, {'type': 'pointerUp', 'button': 0}]}]})
        h['invoke']('write_clipboard_text', text='CI_SELECTION_SENTINEL')
        double_click()
        h['wait'](lambda: h['invoke']('read_clipboard_text') == 'WORD_SETTINGS', 'configured repeated click selects and copies a word')
        settings('copy-on-select = clipboard\nclick-repeat-interval = 0\n')
        h['invoke']('write_clipboard_text', text='CI_SELECTION_DISABLED')
        double_click()
        time.sleep(.2)
        assert h['invoke']('read_clipboard_text') == 'CI_SELECTION_DISABLED'
        h['check']('double-click selection copies the word when enabled and repeated-click interval zero disables it')

        settings('clipboard-read = ask\nclipboard-write = ask\n')
        h['invoke']('write_clipboard_text', text='CI_ASK_CLIPBOARD')
        clipboard_program(b'\x1b]52;c;YWNjZXB0ZWQ=\x07', 'CI_ASK_WRITE_FINISHED')
        h['wait'](lambda: h['shown']('[data-app-dialog]'), 'OSC52 clipboard permission prompt')
        assert h['invoke']('read_clipboard_text') == 'CI_ASK_CLIPBOARD'
        h['click']('[data-action="cancel-app-dialog"]')
        assert h['invoke']('read_clipboard_text') == 'CI_ASK_CLIPBOARD'
        clipboard_program(b'\x1b]52;c;YWNjZXB0ZWQ=\x07', 'CI_ASK_WRITE_ACCEPT_FINISHED')
        h['wait'](lambda: h['shown']('[data-app-dialog]'), 'second OSC52 clipboard permission prompt')
        h['click']('[data-action="accept-app-dialog"]')
        h['wait'](lambda: h['invoke']('read_clipboard_text') == 'accepted', 'explicit clipboard write approval')
        h['check']('OSC52 ask leaves clipboard unchanged on cancel and writes only after approval')
        h['screenshot']('terminal-settings-native-review.png')
    finally:
        if h['shown']('[data-app-dialog]'):
            h['click']('[data-action="cancel-app-dialog"]')
        path.write_text(original)
