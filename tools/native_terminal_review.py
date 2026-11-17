"""Focused adversarial checks against the running native WebKitGTK app and real PTY."""
import base64
import json
import shlex
import time


def run(h):
    def output_has(text):
        return h['execute']("return [...document.querySelectorAll('.terminal-host:not([hidden]) .ghostty-accessibility')].some(el=>el.textContent.includes(arguments[0]));", text)

    def input_element():
        return h['element']('.terminal-host:not([hidden]) .ghostty-input')

    def type_text(text):
        h['request']('POST', f"/session/{h['session']}/element/{input_element()}/value", {'text': text})

    def keys(*values):
        actions = []
        for value in values:
            actions.extend([{'type': 'keyDown', 'value': value}, {'type': 'keyUp', 'value': value}])
        h['request']('POST', f"/session/{h['session']}/actions", {'actions': [{'type': 'key', 'id': 'review-keyboard', 'actions': actions}]})

    def chord(*values):
        actions = [{'type': 'keyDown', 'value': value} for value in values]
        actions += [{'type': 'keyUp', 'value': value} for value in reversed(values)]
        h['request']('POST', f"/session/{h['session']}/actions", {'actions': [{'type': 'key', 'id': 'review-keyboard', 'actions': actions}]})

    def program(code, ready):
        encoded = base64.b64encode(code.encode()).decode()
        type_text('python3 -c ' + shlex.quote(f"import base64;exec(base64.b64decode('{encoded}'))") + '\n')
        h['wait'](lambda: output_has(ready), ready)

    def browser_paste(text):
        h['execute']("const el=document.querySelector('.terminal-host:not([hidden]) .ghostty-input'); const data=new DataTransfer();data.setData('text/plain',arguments[0]);el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));", text)

    # Real PTY capture: application cursor keys and protected bracketed paste must be exact bytes.
    program("""import os,sys,tty,termios,select
old=termios.tcgetattr(0);tty.setraw(0)
try:
 os.write(1,b'\\x1b[?1h\\x1b[?2004hREVIEW_RAW_READY\\r\\n')
 data=b''
 while b'\\x04' not in data:
  if not select.select([0],[],[],12)[0]: raise RuntimeError('input timeout')
  data+=os.read(0,4096)
 os.write(1,b'\\r\\nREVIEW_CAPTURE_'+data.split(b'\\x04')[0].hex().encode()+b'\\r\\n')
finally:
 os.write(1,b'\\x1b[?1l\\x1b[?2004l');termios.tcsetattr(0,termios.TCSANOW,old)
""", 'REVIEW_RAW_READY')
    keys('\ue013')  # ArrowUp in application-cursor mode.
    browser_paste('line1\nline2')
    chord('\ue009', 'd')
    expected = b'\x1bOA\x1b[200~line1\nline2\x1b[201~'
    h['wait'](lambda: output_has('REVIEW_CAPTURE_' + expected.hex()), 'native arrow and bracketed-paste bytes')
    h['check']('real PTY receives application arrows and browser bracketed paste without executing pasted lines')

    # A browser paste outside bracketed mode must go through the same confirmation as the shortcut.
    browser_paste("printf 'REVIEW_UNSAFE_PASTE'\nprintf 'SECOND_LINE'\n")
    h['wait'](lambda: h['shown']('[data-app-dialog]'), 'multiline paste protection')
    assert not output_has('REVIEW_UNSAFE_PASTE')
    h['click']('[data-action="cancel-app-dialog"]')
    h['check']('browser multiline paste requires confirmation and cancellation sends no terminal input')

    # Some WebKit IMEs send a final input event after compositionend. Commit once in either order.
    program("""import os,tty,termios,select
old=termios.tcgetattr(0);tty.setraw(0)
try:
 os.write(1,b'REVIEW_IME_READY\\r\\n');data=b''
 while b'\\x04' not in data:
  if not select.select([0],[],[],12)[0]:raise RuntimeError('input timeout')
  data+=os.read(0,4096)
 os.write(1,b'\\r\\nREVIEW_IME_'+data.split(b'\\x04')[0].hex().encode()+b'\\r\\n')
finally:termios.tcsetattr(0,termios.TCSANOW,old)
""", 'REVIEW_IME_READY')
    h['execute']("const el=document.querySelector('.terminal-host:not([hidden]) .ghostty-input');el.dispatchEvent(new CompositionEvent('compositionstart',{data:'',bubbles:true}));el.value='é界';el.dispatchEvent(new InputEvent('input',{data:'é界',isComposing:true,bubbles:true}));el.dispatchEvent(new CompositionEvent('compositionend',{data:'é界',bubbles:true}));el.value='é界';el.dispatchEvent(new InputEvent('input',{data:'é界',bubbles:true}));")
    chord('\ue009', 'd')
    h['wait'](lambda: output_has('REVIEW_IME_' + 'é界'.encode().hex()), 'single IME commit')
    assert not output_has('REVIEW_IME_' + ('é界' * 2).encode().hex())
    h['check']('compositionend and final browser input commit a Unicode IME result exactly once')

    # Two live frames separated by a render hold: partial drawing must not leak, and abandoned holds expire.
    program("""import os,time
os.write(1,b'\\x1b[2J\\x1b[HREVIEW_BEFORE_HOLD\\r\\n');time.sleep(.3)
os.write(1,b'\\x1b[?2026h\\x1b[HREVIEW_DURING_HOLD');time.sleep(.65)
os.write(1,b'\\x1b[?2026l\\r\\nREVIEW_HOLD_FINISHED\\r\\n')
""", 'REVIEW_BEFORE_HOLD')
    time.sleep(.4)
    assert not output_has('REVIEW_DURING_HOLD'), 'synchronized output leaked before mode 2026 ended'
    h['wait'](lambda: output_has('REVIEW_HOLD_FINISHED'), 'render hold release')
    h['check']('synchronized terminal output stays frozen until its frame is complete')
    program("""import os,time
os.write(1,b'\\x1b[?2026h\\x1b[HREVIEW_HOLD_TIMEOUT');time.sleep(2)
os.write(1,b'\\x1b[?2026l\\r\\nREVIEW_TIMEOUT_FINISHED\\r\\n')
""", 'REVIEW_HOLD_TIMEOUT')
    h['wait'](lambda: output_has('REVIEW_TIMEOUT_FINISHED'), 'stuck render hold recovers')
    h['check']('a program that abandons synchronized output cannot freeze the pane indefinitely')

    program("""import os
os.write(1,b'\\x1b[?2026h')
os.write(1,b' '*(5*1024*1024))
os.write(1,b'\\x1b[?2026l\\r\\nREVIEW_FLOOD_FINISHED\\r\\n')
""", 'REVIEW_FLOOD_FINISHED')
    h['check']('more than 4 MiB of synchronized PTY output drains without a flow-control deadlock')

    # Mouse events go to the requesting program, including release after a captured drag.
    program("""import os,tty,termios,select,re
old=termios.tcgetattr(0);tty.setraw(0)
try:
 os.write(1,b'\\x1b[?1000h\\x1b[?1006hREVIEW_MOUSE_READY\\r\\n');data=b''
 while not re.search(rb'\\x1b\\[<0;[0-9]+;[0-9]+m',data):
  if not select.select([0],[],[],12)[0]:raise RuntimeError('mouse timeout')
  data+=os.read(0,4096)
 os.write(1,b'\\r\\nREVIEW_MOUSE_OK\\r\\n')
finally:
 os.write(1,b'\\x1b[?1000l\\x1b[?1006l');termios.tcsetattr(0,termios.TCSANOW,old)
""", 'REVIEW_MOUSE_READY')
    rect = h['execute']("const r=document.querySelector('.terminal-host:not([hidden]) canvas').getBoundingClientRect();return {x:Math.round(r.left+30),y:Math.round(r.top+30)};")
    h['request']('POST', f"/session/{h['session']}/actions", {'actions': [{'type': 'pointer', 'id': 'review-mouse', 'parameters': {'pointerType': 'mouse'}, 'actions': [
        {'type': 'pointerMove', 'x': rect['x'], 'y': rect['y']}, {'type': 'pointerDown', 'button': 0},
        {'type': 'pointerMove', 'x': rect['x']+50, 'y': rect['y']+20, 'duration': 80}, {'type': 'pointerUp', 'button': 0}]}]})
    h['wait'](lambda: output_has('REVIEW_MOUSE_OK'), 'SGR mouse press and release reach real PTY')
    h['check']('native SGR mouse press, drag and release reach the requesting terminal program')
    h['invoke']('plugin:clipboard-manager|write_text',text='review-empty-clipboard')
    chord('\ue009','\ue008','a')
    chord('\ue009','\ue008','c')
    h['wait'](lambda:'REVIEW_MOUSE_OK' in h['invoke']('plugin:clipboard-manager|read_text'), 'rapid select-all then copy retrieves current native selection')
    h['check']('rapid select-all then copy reads the current native selection instead of a stale cache')
    h['screenshot']('terminal-review-input-and-rendering.png')
