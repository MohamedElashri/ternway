#!/usr/bin/env python3
"""Isolated Linux WebKitGTK end-to-end checks; no browser simulation or live accounts."""
import base64
import http.client
import json
import os
from pathlib import Path
import select
import socket
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

if not sys.platform.startswith("linux"):
    raise SystemExit("Run this harness on an isolated Linux test runner.")
binary = Path(sys.argv[1]).resolve(strict=True)
root = Path(os.environ["TERNWAY_GUI_ROOT"]).resolve()
root.mkdir(mode=0o700, parents=True, exist_ok=False)
artifacts = root / "artifacts"
artifacts.mkdir()
for name in ["config", "data", "cache", "shell"]:
    (root / name).mkdir(mode=0o700)
os.environ.update({"XDG_CONFIG_HOME": str(root / "config"), "XDG_DATA_HOME": str(root / "data"), "XDG_CACHE_HOME": str(root / "cache"), "SHELL": "/bin/sh", "ENV": "/dev/null", "BASH_ENV": "/dev/null", "ZDOTDIR": str(root / "shell"), "TAURI_WEBVIEW_AUTOMATION": "true"})
os.environ['TERNWAY_QA_KNOWN_HOSTS'] = str(root / 'known_hosts')
config = root / "config" / "ternway"
config.mkdir()
(config / "config").write_text("shell-integration = none\nwindow-save-state = always\nsave-scrollback = false\nclipboard-history = false\n")
log = (artifacts / "driver.log").open("w")
driver = subprocess.Popen(["tauri-driver", "--native-driver", "/usr/bin/WebKitWebDriver"], stdout=log, stderr=log, start_new_session=True)
base = "http://127.0.0.1:4444"
session = None
fixture = None
fixture_log = None
checks = []

def request(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=35) as response:
            value = json.load(response).get("value")
    except urllib.error.HTTPError as error:
        detail = json.loads(error.read()).get("value", {})
        raise RuntimeError(str(detail)) from error
    if isinstance(value, dict) and value.get("error"):
        raise RuntimeError(str(value))
    return value

def wait(test, description, timeout=30):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            result = test()
            if result:
                return result
        except (RuntimeError, urllib.error.URLError, http.client.RemoteDisconnected) as error:
            # WebKit can reset a polling connection while restored webviews attach.
            # Keep the same bounded assertion; a persistent disconnect still fails.
            last = error
        time.sleep(0.15)
    raise AssertionError(f"Timed out: {description}: {last}")

def execute(script, *args):
    return request("POST", f"/session/{session}/execute/sync", {"script": script, "args": list(args)})

def invoke(command, **args):
    result = request("POST", f"/session/{session}/execute/async", {"script": "const done=arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({ok:true,value}),error=>done({ok:false,error}));", "args": [command, args]})
    if not result["ok"]:
        raise RuntimeError(str(result["error"]))
    return result.get("value")

def element(selector):
    result = request("POST", f"/session/{session}/element", {"using": "css selector", "value": selector})
    return result["element-6066-11e4-a52e-4f735466cecf"]

def click(selector):
    deadline = time.monotonic() + 30
    def prepare():
        target = element(selector)
        present = execute("const el=document.querySelector(arguments[0]); if(!el) return false; el.scrollIntoView({block:'center'}); return true;", selector)
        return target if present else None
    while time.monotonic() < deadline:
        # Lookup/scroll are safe to retry if WebKit resets its connection during
        # a render. Do not replay a click whose delivery is uncertain.
        target = wait(prepare, selector, timeout=max(0, deadline-time.monotonic()))
        try:
            request("POST", f"/session/{session}/element/{target}/click", {})
            return
        except RuntimeError as error:
            # Queue-completion events can replace a button between lookup and
            # click. A stale reference means the driver never clicked it.
            if 'stale element reference' not in str(error):
                raise
    raise AssertionError(f'Continuously replaced click target: {selector}')

def type_into(selector, text):
    target = element(selector)
    request("POST", f"/session/{session}/element/{target}/clear", {})
    request("POST", f"/session/{session}/element/{target}/value", {"text": text, "value": list(text)})

def shown(selector):
    return execute("const el=document.querySelector(arguments[0]);return !!el && !!el.getClientRects().length;", selector)

def compact_terminal_geometry():
    result = execute("""
      const surface=document.querySelector('[data-terminal-surface]'), content=document.querySelector('.content-area');
      const frame=content.getBoundingClientRect(), terminal=surface.getBoundingClientRect();
      const tabs=document.querySelector('.workspace-tabbar').getBoundingClientRect();
      const controls=Array.from(content.querySelectorAll('[data-action="new-terminal"], [data-action="clear-terminal"], [data-action="reconnect-terminal"]'));
      return {gap:terminal.top-tabs.bottom, bottom:frame.bottom-terminal.bottom,
        height:terminal.height, available:frame.height, scroll:content.scrollHeight-content.clientHeight,
        heading:!!content.querySelector('.page-head'),
        controlsFit:controls.length>=2 && controls.every(el=>{const r=el.getBoundingClientRect();return r.width>0 && r.left>=frame.left && r.right<=frame.right && r.top>=frame.top && r.bottom<=terminal.top;})};
    """)
    assert 0 <= result['gap'] <= 40 and abs(result['bottom']) <= 1, result
    assert result['height'] >= result['available'] - 40 and result['scroll'] <= 1, result
    assert not result['heading'] and result['controlsFit'], result
    return result

def start():
    global session
    response = request("POST", "/session", {"capabilities": {"alwaysMatch": {"tauri:options": {"application": str(binary)}}}})
    session = response["sessionId"]
    request("POST", f"/session/{session}/timeouts", {"script": 30000, "pageLoad": 30000, "implicit": 0})
    wait(lambda: shown('[data-action="credential-settings"]'), "app bootstrap")

def screenshot(name):
    value = request("GET", f"/session/{session}/screenshot")
    (artifacts / name).write_bytes(base64.b64decode(value))

def check(name):
    checks.append(name)
    print(f"PASS {name}", flush=True)

trap = socket.socket()
trap.bind(("127.0.0.1", 0))
trap.listen()
port = trap.getsockname()[1]
ssh_config = root / "ssh-config"
ssh_config.write_text(f"Host ci-loopback\n HostName 127.0.0.1\n User qa\n Port {port}\nHost github.com\n HostName github.com\n User git\n")
try:
    wait(lambda: request("GET", "/status") is not None, "driver startup")
    start()
    def check_startup_size():
        size = execute("return {width:window.innerWidth,height:window.innerHeight};")
        assert 1100 <= size['width'] <= 1440 and 700 <= size['height'] <= 900, size
    check_startup_size()
    check('fresh native window opens at its configured usable size')
    wait(lambda: element('.xterm-helper-textarea'), 'initial local shell')
    click('.term-tab-close')
    wait(lambda: shown('.terminal-empty') or shown('[data-app-dialog]'), 'close final local terminal')
    if shown('[data-app-dialog]'):
        click('[data-action="accept-app-dialog"]')
    wait(lambda: shown('.terminal-empty'), 'last local shell stays closed')
    assert execute("return document.querySelectorAll('.terminal-host').length;") == 0
    click('[data-workspace-close="local"]')
    wait(lambda: not shown('.workspace-tab-local'), 'local workspace closes')
    click('[data-action="open-local"]')
    wait(lambda: element('.xterm-helper-textarea'), 'explicitly reopen local workspace')
    assert execute("return document.querySelectorAll('.term-tab').length;") == 1
    check('last local terminal and Local workspace close without replacement shells and reopen explicitly')
    textarea = wait(lambda: element('.xterm-helper-textarea'), "local terminal")
    # The marker is encoded in the command so shell echo cannot satisfy this assertion.
    expected = "CI_NATIVE_λ_漢字"
    escaped = ''.join('\\%03o' % byte for byte in expected.encode())
    request("POST", f"/session/{session}/element/{textarea}/value", {"text": f"printf '{escaped}\\n'\n"})
    wait(lambda: execute("return document.querySelector('.terminal-layer')?.textContent?.includes(arguments[0]) || Array.from(document.querySelectorAll('.xterm-rows')).some(el=>el.textContent.includes(arguments[0]));", expected), "real PTY Unicode output")
    check("native WebKitGTK terminal accepts input and renders UTF-8 process output")
    for width, height in [(1000, 700), (1280, 850), (1080, 720), (1400, 900)]:
        request("POST", f"/session/{session}/window/rect", {"width": width, "height": height})
    check("window resizing keeps the terminal alive")

    click('[data-action="new-terminal"]')
    tab_ids = wait(lambda: execute("const tabs=Array.from(document.querySelectorAll('.term-tab')); return tabs.length===2 && tabs.map(el=>el.dataset.tabGroup);"), 'second local terminal tab')
    drag_points = execute("""
      const tab=document.querySelector('.term-tab').getBoundingClientRect();
      const surface=document.querySelector('[data-terminal-surface]').getBoundingClientRect();
      return {x:Math.round(tab.left+30), y:Math.round(tab.top+tab.height/2),
        endX:Math.round(surface.right-30), endY:Math.round(surface.top+60)};
    """)
    # The xterm overlay is outside the app root. Pointer capture must retain
    # the release when a tab is dragged over it, just as outside the window.
    request('POST', f'/session/{session}/actions', {'actions':[{'type':'pointer', 'id':'tab-drag', 'parameters':{'pointerType':'mouse'}, 'actions':[
        {'type':'pointerMove', 'duration':0, 'origin':'viewport', 'x':drag_points['x'], 'y':drag_points['y']},
        {'type':'pointerDown', 'button':0},
        {'type':'pointerMove', 'duration':250, 'origin':'viewport', 'x':drag_points['endX'], 'y':drag_points['endY']},
        {'type':'pointerUp', 'button':0},
    ]}]})
    wait(lambda: execute("return Array.from(document.querySelectorAll('.term-tab')).map(el=>el.dataset.tabGroup).join(',')===arguments[0];", ','.join(reversed(tab_ids))), 'terminal drag completes over the terminal overlay')
    request('DELETE', f'/session/{session}/actions')
    click(f'.term-tab[data-tab-group="{tab_ids[0]}"]')
    wait(lambda: execute("return document.querySelector('.term-tab.active')?.dataset.tabGroup===arguments[0] && !document.querySelector('.term-tab.dragging,.term-tab.drop-before,.term-tab.drop-after');", tab_ids[0]), 'next tab click remains responsive')
    check('terminal tabs finish drag over the terminal overlay and accept the next ordinary click')

    click('[data-action="credential-settings"]')
    sections = execute("return Array.from(document.querySelectorAll('.settings-nav button')).map(el=>el.textContent.trim());")
    assert sections == ['Appearance', 'Terminal', 'Connections', 'Security', 'Updates', 'About'], sections
    assert execute("return document.querySelectorAll('.settings-group').length===1 && !!document.querySelector('#settings-appearance') && !document.querySelector('#settings-terminal');")
    click('[data-settings-page="terminal"]')
    assert execute("return !!document.querySelector('[data-field=terminal-renderer]') && !document.querySelector('#settings-appearance');")
    click('[data-settings-page="security"]')
    assert execute("return !!document.querySelector('[data-action=lock-vault]') && !document.querySelector('[data-field=terminal-renderer]');")
    click('[data-settings-page="about"]')
    wait(lambda: execute("return !!document.querySelector('.settings-content .about-details') && !document.querySelector('#settings-security');"), 'About settings page')
    click('[data-settings-page="appearance"]')
    request('POST', f'/session/{session}/window/rect', {'width':640, 'height':480})
    assert execute("const modal=document.querySelector('.modal-settings'), nav=document.querySelector('.settings-nav'), footer=document.querySelector('.settings-footer');return modal.scrollHeight<=modal.clientHeight+1 && nav.getBoundingClientRect().top>=0 && footer.getBoundingClientRect().bottom<=window.innerHeight;")
    screenshot('settings-pages-narrow.png')
    request('POST', f'/session/{session}/window/rect', {'width':1400, 'height':900})
    screenshot('settings-pages.png')

    assert sections[-1] == "About", sections
    assert execute("return document.querySelector('#app').dataset.colorTheme;") == 'github-dark'
    theme_backgrounds = [('github-light','#ffffff'), ('github-dark','#0d1117'), ('github-dark-dimmed','#22272e'), ('github-light-high-contrast','#ffffff'), ('github-dark-high-contrast','#0a0c10'), ('github-light-colorblind','#ffffff'), ('github-dark-colorblind','#0d1117'), ('dracula','#282a36')]
    for theme_id, background in theme_backgrounds:
        click(f'[data-theme-id="{theme_id}"]')
        wait(lambda: execute("return document.querySelector('#app').dataset.colorTheme===arguments[0] && getComputedStyle(document.documentElement).getPropertyValue('--terminal-background').trim()===arguments[1];", theme_id, background), f'live {theme_id} workspace and terminal palette')
        assert execute("return document.querySelector('.terminal-layer').textContent.includes(arguments[0]);", expected), 'Theme changes preserve terminal output'
        if theme_id in ['github-dark','github-light']:
            screenshot(theme_id + '.png')
    original_config = (config / 'config').read_text()
    (config / 'config').write_text(original_config + 'background = #123456\n')
    wait(lambda: execute("return getComputedStyle(document.documentElement).getPropertyValue('--terminal-background').trim()==='#123456';"), 'explicit terminal color applied')
    click('[data-theme-id="github-light"]')
    wait(lambda: execute("return document.querySelector('#app').dataset.colorTheme==='github-light' && getComputedStyle(document.documentElement).getPropertyValue('--terminal-background').trim()==='#123456';"), 'terminal config color survives workspace theme change')
    (config / 'config').write_text(original_config)
    wait(lambda: execute("return getComputedStyle(document.documentElement).getPropertyValue('--terminal-background').trim()==='#ffffff';"), 'terminal returns to preset after removing color override')
    click('[data-theme-id="github-dark-dimmed"]')
    wait(lambda: execute("return getComputedStyle(document.documentElement).getPropertyValue('--terminal-background').trim()==='#22272e';"), 'dimmed palette restored')
    check('all built-in themes apply live without losing terminal output and preserve explicit config colors')
    click('[data-action="close-modal"]')
    assert execute("return document.querySelectorAll('[data-action=theme]').length;") == 1
    click('[data-action="theme"]')
    if execute("return document.querySelector('[data-theme]')?.dataset.theme;") != "dark":
        click('[data-action="theme"]')
    check("settings order and native dark-mode controls")

    click('[data-action="add-server"]')
    type_into('[data-form="server"] [name="name"]', 'CI save only')
    type_into('[data-form="server"] [name="host"]', '127.0.0.1')
    type_into('[data-form="server"] [name="username"]', 'qa')
    click('[data-managed-route] > summary')
    type_into('[data-form="server"] [name="port"]', str(port))
    type_into('[data-form="server"] [name="password"]', 'disposable privacy fixture')
    invoke('lock_credentials')
    wait(lambda: execute("return !!document.querySelector('[data-form=server]') && document.querySelector('[data-form=server] [name=password]').value==='';"), 'credential lock clears secrets without losing the draft')
    assert execute("return document.querySelector('[data-form=server] [name=name]').value==='CI save only' && document.querySelector('[data-form=server] [name=host]').value==='127.0.0.1';")
    check('credential locking clears password fields and retains the unsaved connection')
    click('[data-form="server"] button[type="submit"]')
    wait(lambda: not shown('[data-form="server"]'), "save-only connection")
    assert len(invoke("get_state")["servers"]) == 1
    trap.settimeout(0.1)
    try:
        connection, _ = trap.accept()
        connection.close()
        raise AssertionError("Saving a connection contacted the SSH host")
    except socket.timeout:
        pass
    check("password profile saves without contacting its host or asking for credentials")

    for attempt in range(2):
        click('[data-action="import-ssh-config"]')
        type_into('[data-form="ssh-import"] [name="path"]', str(ssh_config))
        click('[data-action="load-ssh-config"]')
        wait(lambda: execute("return document.querySelectorAll('.import-host').length===2;"), "SSH config preview")
        assert execute("return Array.from(document.querySelectorAll('.import-host')).filter(el=>el.textContent.includes('github.com')).every(el=>!el.querySelector('input').checked);")
        contrast = execute(r"""
          const el=document.querySelector('.import-host strong');
          const rgb=value=>(value.match(/[\d.]+/g)||[]).map(Number);
          const fg=rgb(getComputedStyle(el).color);
          let bg; for(let node=el;node;node=node.parentElement){const value=rgb(getComputedStyle(node).backgroundColor);if(value.length===3 || value[3]>0.99){bg=value;break;}}
          const lum=values=>values.slice(0,3).map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
          const a=lum(fg),b=lum(bg);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
        """)
        assert contrast >= 4.5, f"Dark import text contrast is too low: {contrast}"
        click('[data-form="ssh-import"] button[type="submit"]')
        wait(lambda: len(invoke("get_state")["servers"]) == 2, "duplicate-safe import")
        wait(lambda: execute("return document.querySelector('[data-import-error]')?.textContent.includes('Imported');"), "visible import completion")
        screenshot(f"ssh-import-dark-{attempt}.png")
        click('[data-action="close-modal"]')
    check("native SSH import excludes Git by default, stays readable and deduplicates repeat imports")

    saved_connection = next(server for server in invoke('get_state')['servers'] if server['name'] == 'CI save only')
    click('[data-action="connection-folders"]')
    click('[data-action="create-connection-folder"]')
    type_into('[data-form="input-prompt"] [name="value"]', 'Work/Production')
    click('[data-form="input-prompt"] button[type="submit"]')
    wait(lambda: 'Work/Production' in invoke('get_state')['connectionFolders'], 'nested folder persisted')
    click(f'[data-action="move-connection-folder"][data-connection-id="{saved_connection["id"]}"]')
    type_into('[data-form="input-prompt"] [name="value"]', 'Work/Production')
    click('[data-form="input-prompt"] button[type="submit"]')
    wait(lambda: next(server for server in invoke('get_state')['servers'] if server['id'] == saved_connection['id'])['groupName'] == 'Work/Production', 'connection moved into folder')
    click('[data-action="rename-connection-folder"][data-folder="Work"]')
    type_into('[data-form="input-prompt"] [name="value"]', 'Company')
    click('[data-form="input-prompt"] button[type="submit"]')
    wait(lambda: 'Company/Production' in invoke('get_state')['connectionFolders'], 'folder subtree renamed')
    click('[data-action="create-connection-folder"]')
    click('[data-form="input-prompt"] [data-action="close-modal"]')
    wait(lambda: shown('[data-action="create-connection-folder"]'), 'cancel returns to folder manager')
    click('[data-action="close-modal"]')
    assert shown('[data-connection-group="folder:company/production"]')
    assert execute("return document.querySelector('.connection-folder .server-item-copy').getBoundingClientRect().width >= 100;"), 'Nested connection names need room beside row actions'
    screenshot('connection-folders.png')
    check('folder UI creates nested folders, moves connections, renames subtrees and returns on cancel')
    other_connection = next(server for server in invoke('get_state')['servers'] if server['id'] != saved_connection['id'])
    click('[data-action="connection-folders"]')
    click(f'[data-action="move-connection-folder"][data-connection-id="{other_connection["id"]}"]')
    type_into('[data-form="input-prompt"] [name="value"]', 'Company/Production')
    click('[data-form="input-prompt"] button[type="submit"]')
    wait(lambda: next(server for server in invoke('get_state')['servers'] if server['id'] == other_connection['id'])['groupName'] == 'Company/Production', 'second connection moved into folder')
    click('[data-action="close-modal"]')
    click('[data-action="connection-order"]')
    original_order = execute("return Array.from(document.querySelectorAll('.connection-order-row')).map(row=>row.querySelector('[data-connection-id]').dataset.connectionId);")
    click(f'[data-action="move-connection-down"][data-connection-id="{original_order[0]}"]')
    wait(lambda: invoke('get_state')['connectionOrder'] == list(reversed(original_order)), 'connection order persisted inside nested folder')
    click('[data-action="close-modal"]')
    wait(lambda: execute("return Array.from(document.querySelectorAll('[data-connection-group=\"folder:company/production\"] .server-item')).map(row=>row.dataset.serverId);") == list(reversed(original_order)), 'sidebar reflects saved ordering')
    screenshot('connection-order-folders.png')
    check('saved connection order agrees with sidebar order inside nested folders')

    backup = root / "library.json"
    invoke("export_library_backup", path=str(backup), includeSecrets=False)
    archive = json.loads(backup.read_text())
    assert archive["version"] == 1 and archive["encryptedVault"] is None
    assert len(archive["tables"]["servers"]) == 2
    check("library export uses real IPC and excludes saved secrets by default")

    fixture_root = root / 'ssh-fixture'
    fixture_root.mkdir(mode=0o700)
    fixture_log = (artifacts / 'ssh-fixture.log').open('w')
    fixture = subprocess.Popen([sys.executable, 'tests/fixtures/ssh_password_server.py', 'features', str(fixture_root)], stdout=subprocess.PIPE, stderr=fixture_log, text=True)
    assert select.select([fixture.stdout], [], [], 15)[0], 'SSH fixture startup timed out'
    fixture_port = int(fixture.stdout.readline().strip())
    click('[data-action="add-server"]')
    type_into('[data-form="server"] [name="name"]', 'CI fixture SSH')
    type_into('[data-form="server"] [name="host"]', '127.0.0.1')
    type_into('[data-form="server"] [name="username"]', 'qa')
    click('[data-managed-route] > summary')
    type_into('[data-form="server"] [name="port"]', str(fixture_port))
    click('[data-action="save-and-test"]')
    wait(lambda: shown('[data-action="trust-host-key"]'), 'fixture host-key review')
    import hashlib
    host_key = (fixture_root / 'known_hosts').read_text().split()[2]
    fingerprint = 'SHA256:' + base64.b64encode(hashlib.sha256(base64.b64decode(host_key)).digest()).decode().rstrip('=')
    assert execute('return document.body.textContent.includes(arguments[0]);', fingerprint), 'Trust prompt must identify the generated fixture host key'
    click('[data-action="trust-host-key"]')
    wait(lambda: shown('[data-form="ssh-password"]'), 'password login prompt')
    type_into('[data-form="ssh-password"] [name="password"]', 'incorrect fixture password')
    click('[data-form="ssh-password"] button[type="submit"]')
    wait(lambda: shown('[data-action="connect"]'), 'rejected password leaves a retryable connection')
    click('[data-action="connect"]')
    wait(lambda: shown('[data-form="ssh-password"]'), 'password prompt after rejected credentials')
    type_into('[data-form="ssh-password"] [name="password"]', ' fixture SSH password ')
    click('[data-form="ssh-password"] button[type="submit"]')
    wait(lambda: execute("return document.body.textContent.includes('fixture-linux');"), 'authenticated overview')
    system_disk = execute("return Array.from(document.querySelectorAll('.stat-card')).find(el=>el.textContent.includes('System disk'))?.textContent;")
    assert '25%' in system_disk and 'free on /' in system_disk and '/run' not in system_disk, system_disk
    check('real SSH host-key review, rejected-password recovery and root-filesystem overview')
    assert execute("return document.querySelectorAll('[data-action=theme]').length;") == 1, 'Remote sidebar must not duplicate the global theme toggle'
    click('.nav-item[data-view="terminal"]')
    wait(lambda: execute("return document.querySelector('.terminal-layer')?.textContent.includes('fixture-terminal-ready');"), 'interactive SSH terminal output')
    def check_tab_alignment():
        def measured():
            return execute("const work=[...document.querySelectorAll('.workspace-tab')].map(el=>{const r=el.getBoundingClientRect();return {height:r.height,top:r.top};});const terms=[...document.querySelectorAll('.term-tab')].map(el=>el.getBoundingClientRect().height);const visible=[...document.querySelectorAll('.workspace-tabs .workspace-tab.active,.terminal-tab-list .term-tab.active')].every(el=>{const a=el.getBoundingClientRect(),b=el.parentElement.getBoundingClientRect();return a.left>=b.left-1&&a.right<=b.right+1;});return {work,terms,visible,nested:document.querySelectorAll('button button').length};")
        geometry = wait(lambda: (value if (value:=measured())['visible'] else None), 'selected tab and close control stay visible after resize')
        assert geometry['work'] and all(abs(tab['height']-34)<1 for tab in geometry['work']), geometry
        assert max(tab['top'] for tab in geometry['work'])-min(tab['top'] for tab in geometry['work'])<1, geometry
        assert all(abs(height-34)<1 for height in geometry['terms']), geometry
        assert geometry['nested']==0, geometry
    check_tab_alignment()
    workspace_point=execute("const rect=document.querySelector('.workspace-tab.active:not(.workspace-tab-local)').getBoundingClientRect();return {x:rect.left+60,y:rect.top+rect.height/2};")
    request('POST', f'/session/{session}/actions', {'actions':[{'type':'pointer','id':'workspace-rename','parameters':{'pointerType':'mouse'},'actions':[
      {'type':'pointerMove','duration':0,'origin':'viewport','x':int(workspace_point['x']),'y':int(workspace_point['y'])},
      {'type':'pointerDown','button':0},{'type':'pointerUp','button':0},{'type':'pause','duration':100},
      {'type':'pointerDown','button':0},{'type':'pointerUp','button':0}]}]})
    wait(lambda: shown('[data-form="workspace-tab-rename"]'), 'double-click renames selected workspace without rebuilding its click target')
    type_into('[data-form="workspace-tab-rename"] [name="label"]', 'QA remote')
    click('[data-form="workspace-tab-rename"] button[type="submit"]')
    wait(lambda: execute("return document.querySelector('.workspace-tab.active .workspace-tab-copy')?.textContent==='QA remote';"), 'workspace label saved')
    def remote_input(text):
        target = execute("return document.querySelector('.terminal-host:not([hidden]) .xterm-helper-textarea');")
        request('POST', f'/session/{session}/element/{target["element-6066-11e4-a52e-4f735466cecf"]}/value', {'text':text})
    remote_input('CI_REMOTE_λ_漢字\n')
    wait(lambda: execute("return document.querySelector('.terminal-layer')?.textContent.includes('CI_REMOTE_λ_漢字');"), 'SSH input and UTF-8 echo')
    for width, height in [(1400, 900), (820, 650), (640, 480)]:
        request('POST', f'/session/{session}/window/rect', {'width':width, 'height':height})
        wait(lambda: execute('return Math.abs(window.innerWidth-arguments[0])<=16;', width), 'resized remote terminal viewport')
        check_tab_alignment()
        compact_terminal_geometry()
    screenshot('remote-terminal-compact.png')
    click('[data-action="clear-terminal"]')
    live_group = execute("return document.querySelector('.term-tab.active').dataset.tabGroup;")
    live_pane = execute("return document.querySelector('.term-tab.active').dataset.terminalTab;")
    click('[data-action="reconnect-terminal"]')
    wait(lambda: execute("return document.querySelector('.term-tab.active').dataset.terminalTab !== arguments[0] && !document.querySelector('[data-action=\"reconnect-terminal\"]').disabled;", live_pane), 'live reconnect replaces the session in the same tab')
    assert execute("return document.querySelector('.term-tab.active').dataset.tabGroup;") == live_group
    wait(lambda: execute("return document.querySelector('.terminal-layer')?.textContent.includes('fixture-terminal-ready');"), 'live reconnected shell ready')
    remote_input('exit\n')
    wait(lambda: execute("return document.querySelector('.terminal-session-status')?.textContent.includes('Disconnected');"), 'disconnected terminal keeps reconnect accessible')
    assert execute("return document.querySelector('.nav-item[data-view=dashboard]')?.disabled===false && document.querySelector('.nav-item[data-view=files]')?.disabled===false;"), 'Exiting a shell must not disable tools on its still-authenticated SSH connection'
    compact_terminal_geometry()
    exited_pane = execute("return document.querySelector('.term-tab.active').dataset.terminalTab;")
    click('[data-action="reconnect-terminal"]')
    wait(lambda: execute("return document.querySelector('.term-tab.active').dataset.terminalTab !== arguments[0] && !document.querySelector('[data-action=\"reconnect-terminal\"]').disabled;", exited_pane), 'disconnected reconnect replaces the exited session')
    wait(lambda: execute("return document.querySelector('.terminal-layer')?.textContent.includes('fixture-terminal-ready');"), 'reconnected SSH terminal')
    assert not execute("return document.querySelector('.terminal-layer')?.textContent.includes('CI_REMOTE_λ_漢字');"), 'Reconnect must not replay terminal input'
    remote_input('exit\n')
    wait(lambda: execute("return document.querySelector('.terminal-session-status')?.textContent.includes('Disconnected');"), 'fixture terminal cleanup')
    assert execute("return document.querySelector('.nav-item[data-view=dashboard]')?.disabled===false;"), 'SSH tools must remain available immediately after the last terminal exits'
    request('POST', f'/session/{session}/window/rect', {'width':1400, 'height':900})
    wait(lambda: execute('return Math.abs(window.innerWidth-1400)<=16;'), 'desktop viewport restored after narrow terminal checks')
    click('.nav-item[data-view="dashboard"]')
    wait(lambda: execute("return !!document.querySelector('.nav-item.active[data-view=dashboard]') && !!document.querySelector('.page-head');"), 'overview restored before remote-tool navigation')
    screenshot('workspace-terminal-tabs.png')
    check('remote SSH terminal uses one compact control row and fills desktop/narrow windows, with working input, Clear and reconnect')
    for view, expected_text in [
        ('processes', '/usr/bin/fixture --label two words'),
        ('services', 'failed.service'),
        ('disk', '/dev/root'),
        ('docker', 'fixture-web'),
        ('logs', 'fixture service started'),
        ('network', '[::]:239'),
        ('cron', 'system  fixture'),
        ('packages', 'Fixture package'),
        ('accounts', '/home/qa'),
    ]:
        click(f'.nav-item[data-view="{view}"]')
        wait(lambda: execute("return document.querySelector('.page-head')?.parentElement.textContent.includes(arguments[0]);", expected_text), f'{view} renders authenticated fixture data')
        assert not execute("return !!document.querySelector('.error-panel');"), f'{view} showed an error'
    click('.nav-item[data-view="dashboard"]')
    check('native remote-tool views render processes, failed services, disks, containers, logs, sockets, cron, packages and accounts')
    server = next(row for row in invoke('get_state')['servers'] if row['name'] == 'CI fixture SSH')
    server_id = server['id']
    invoke('remote_file_action', serverId=server_id, action='mkdir', path='/qa-files', target=None, mode=None)
    content = 'Real SFTP fixture: λ 漢字\n'
    invoke('write_remote_file', serverId=server_id, path='/qa-files/example.txt', content=content)
    assert invoke('read_remote_file', serverId=server_id, path='/qa-files/example.txt') == content
    invoke('remote_file_action', serverId=server_id, action='chmod', path='/qa-files/example.txt', target=None, mode='000')
    assert (fixture_root / 'files/qa-files/example.txt').stat().st_mode & 0o777 == 0
    invoke('remote_file_action', serverId=server_id, action='chmod', path='/qa-files/example.txt', target=None, mode='0644')
    invoke('remote_file_action', serverId=server_id, action='rename', path='/qa-files/example.txt', target='renamed.txt', mode=None)
    listing = invoke('list_remote_files', serverId=server_id, request={'path':'/qa-files','showHidden':False,'offset':0,'limit':100})
    assert any(row['name']=='renamed.txt' for row in listing['items'])
    invoke('remote_file_action', serverId=server_id, action='delete', path='/qa-files', target=None, mode=None)
    assert not (fixture_root / 'files/qa-files').exists()
    check('real SFTP create, UTF-8 edit, rename, listing and recursive delete stay within fixture files')
    upload = root / 'fixture-upload.bin'
    upload.write_bytes(bytes(range(256)) * 32768)
    job = invoke('enqueue_transfer', serverId=server_id, direction='upload', localPath=str(upload), remotePath='/')
    click('[data-action="credential-settings"]')
    click('[data-settings-page="connections"]')
    click('[data-action="transfer-queue"]')
    click('[data-action="run-transfer-queue"]')
    wait(lambda: any(p.stat().st_size > 0 for p in (fixture_root / 'files').glob('.fixture-upload.bin.*.part')), 'partial upload before pause')
    click('.modal [data-action="cancel-transfer"]')
    wait(lambda: any(row['id']==job['id'] and row['status']=='paused' for row in invoke('list_transfer_jobs')), 'pause reaches the running transfer')
    assert not (fixture_root / 'files' / upload.name).exists(), 'Paused upload must not publish a partial destination'
    click('[data-job-action="retry"]')
    wait(lambda: any(row['id']==job['id'] and row['status']=='complete' for row in invoke('list_transfer_jobs')), 'resume verifies the checkpoint and finishes', timeout=60)
    assert (fixture_root / 'files' / upload.name).read_bytes() == upload.read_bytes()
    downloaded = root / 'fixture-downloaded.bin'
    job = invoke('enqueue_transfer', serverId=server_id, direction='download', localPath=str(downloaded), remotePath='/' + upload.name)
    click('[data-action="run-transfer-queue"]')
    wait(lambda: any(row['id']==job['id'] and row['status']=='complete' for row in invoke('list_transfer_jobs')), 'queued download finishes', timeout=60)
    assert downloaded.read_bytes() == upload.read_bytes()
    assert all(job['status']=='complete' for job in invoke('list_transfer_jobs'))
    check('native Pause and Retry controls resume real SFTP and commit identical binary upload/download data')
    click('[data-action="close-modal"]')
    click('[data-action="disconnect"]')
    click('[data-action="open-local"]')
    preview = invoke('preview_library_backup', path=str(backup))
    assert preview['connections'] == 2 and not preview['includesSecrets']
    recovery = invoke('restore_library_backup', path=str(backup), checksum=preview['checksum'])
    assert Path(recovery).exists() and len(invoke('get_state')['servers']) == 2
    check('library restore uses checksum preview and retains an automatic rollback backup')

    click('[data-action="workspace-library"]')
    click('[data-action="save-workspace-layout"]')
    type_into('[data-form="input-prompt"] [name="value"]', 'CI native layout')
    click('[data-form="input-prompt"] button[type="submit"]')
    wait(lambda: any(row["name"] == "CI native layout" for row in invoke("list_workspaces")["entries"]), "named layout save")
    layouts = invoke("list_workspaces")["entries"]
    layout = next(row for row in layouts if row["name"] == "CI native layout")
    click('[data-action="close-modal"]')
    invoke("new_workspace_window", layoutId=layout["id"])
    wait(lambda: len(request("GET", f"/session/{session}/window/handles")) >= 2, "second ordinary window")
    original_handle = request('GET', f'/session/{session}/window')
    for handle in request('GET', f'/session/{session}/window/handles'):
        request('POST', f'/session/{session}/window', {'handle':handle})
        check_startup_size()
    request('POST', f'/session/{session}/window', {'handle':original_handle})
    check("named layout opens in another native window at a usable size")

    # Exercise the shipped JS updater and real UI with a simulated IPC installer.
    # No release download, package-manager command, or real restart runs here.
    update_handle = request('GET', f'/session/{session}/window')
    other_handle = next(handle for handle in request('GET', f'/session/{session}/window/handles') if handle != update_handle)
    request('POST', f'/session/{session}/window', {'handle':other_handle})
    wait(lambda: shown('[data-action="credential-settings"]'), 'other window bootstrap before shared update notice')
    request('POST', f'/session/{session}/window', {'handle':update_handle})
    execute("""
      const original = window.fetch;
      const fake = window.__ternwayUpdateTest = { original, checks:0, restarts:0 };
      const reply = (value, ok=true) => new Response(JSON.stringify(value), {headers:{'Content-Type':'application/json','Tauri-Response':ok?'ok':'error'}});
      // Tauri's invoke and IPC properties are immutable in a real webview.
      // Intercept the standard fetch transport instead of assigning to them.
      window.fetch = async (input, options) => {
        const url = new URL(typeof input==='string'?input:input.url);
        if(url.protocol!=='ipc:') return original(input,options);
        const command = decodeURIComponent(url.pathname.slice(1));
        if(!['app_metadata','plugin:updater|check','plugin:updater|download','plugin:updater|install','plugin:resources|close','request_app_restart'].includes(command)) return original(input,options);
        const args = JSON.parse(options.body);
        if(command==='app_metadata') {
          const response = await original(input,options);
          return reply({...await response.json(),updateUnsupportedReason:''});
        }
        if(command==='plugin:updater|check') { fake.checks++; return reply({rid:2140001,currentVersion:'0.3.2',version:'99.0.0-test',body:'Simulated update for native UI coverage'}); }
        if(command==='plugin:updater|download') {
          const channel = Number(args.onEvent.split(':')[1]);
          [{event:'Started',data:{contentLength:10}},{event:'Progress',data:{chunkLength:10}},{event:'Finished'}].forEach((message,index)=>window.__TAURI_INTERNALS__.runCallback(channel,{index,message}));
          window.__TAURI_INTERNALS__.runCallback(channel,{index:3,end:true});
          return reply(2140002);
        }
        if(command==='plugin:updater|install') return new Promise(resolve=>{fake.finishInstall=()=>resolve(reply(null));});
        if(command==='plugin:resources|close' && [2140001,2140002].includes(args.rid)) return reply(null);
        if(command==='request_app_restart') { fake.restarts++; return reply('Restart cancelled; all windows remain open',false); }
        return original(input,options);
      };
      return true;
    """)
    if shown('.backdrop [data-action="close-modal"]'):
        click('.backdrop [data-action="close-modal"]')
    click('[data-action="credential-settings"]')
    click('[data-settings-page="updates"]')
    click('[data-update-section] [data-action="check-updates"]')
    wait(lambda: shown('[data-action="install-update"]'), 'simulated update available')
    click('[data-action="install-update"]')
    wait(lambda: execute("return typeof window.__ternwayUpdateTest.finishInstall==='function';"), 'installer is pending')
    assert not shown('[data-action="restart-update"]'), 'No restart before installation completes'
    assert execute("return document.querySelector('[aria-current=step]')?.textContent;") == 'Install'
    screenshot('update-installing.png')
    click('.modal-updates [data-action="close-modal"]')
    assert shown('[data-update-notice] [data-action="check-updates"]'), 'Background update details stay accessible'
    execute("window.__ternwayUpdateTest.finishInstall(); return true;")
    wait(lambda: shown('[data-update-notice] [data-action="restart-update"]'), 'persistent restart-to-finish notice')
    assert execute("return JSON.parse(localStorage.getItem('ternway-update-restart')).version;") == '99.0.0-test'
    request('POST', f'/session/{session}/window', {'handle':other_handle})
    wait(lambda: shown('[data-update-notice] [data-action="restart-update"]'), 'other window receives restart readiness')
    request('POST', f'/session/{session}/window', {'handle':update_handle})
    click('[data-update-notice] [data-action="restart-update"]')
    click('[data-action="cancel-app-dialog"]')
    assert execute('return window.__ternwayUpdateTest.restarts;') == 0, 'Cancel leaves active terminals running'
    click('[data-action="credential-settings"]')
    click('[data-settings-page="updates"]')
    wait(lambda: shown('[data-update-section] [data-action="restart-update"]'), 'restart readiness survives settings navigation')
    assert not shown('[data-action="install-update"]')
    assert execute('return window.__ternwayUpdateTest.checks;') == 1, 'Ready update is not checked or downloaded again'
    screenshot('update-restart-ready.png')
    click('[data-update-section] [data-action="restart-update"]')
    click('[data-action="accept-app-dialog"]')
    wait(lambda: execute('return window.__ternwayUpdateTest.restarts===1;'), 'restart action reaches save-barrier command')
    wait(lambda: shown('[data-update-section] [data-action="restart-update"]'), 'cancelled shutdown keeps update ready')
    click('.modal-settings [data-action="close-modal"]')
    execute("window.fetch=window.__ternwayUpdateTest.original; localStorage.removeItem('ternway-update-restart'); delete window.__ternwayUpdateTest; return true;")
    check('updater distinguishes installation from restart, retains readiness across navigation and windows, and honours cancellation')

    # Quit exercises the same all-window save barrier used by updater restart.
    execute("setTimeout(()=>window.__TAURI_INTERNALS__.invoke('request_app_quit'),0); return true;")
    data_dir = root / "data" / "dev.elashri.ternway.ci"
    wait(lambda: (data_dir / "windows.json").exists() and len(json.loads((data_dir / "windows.json").read_text())) == 2, "window restore manifest")
    wait(lambda: (data_dir / "session.json").exists() and len(list((data_dir / "sessions").glob('*.json'))) >= 1, "every window saved before exit")
    def app_exited():
        try:
            return not request("GET", f"/session/{session}/window/handles")
        except (RuntimeError, urllib.error.URLError, http.client.RemoteDisconnected):
            return True
    wait(app_exited, "coordinated quit completed without killing the application")
    try:
        request("DELETE", f"/session/{session}")
    except (RuntimeError, urllib.error.URLError, http.client.RemoteDisconnected):
        pass
    session = None
    (data_dir / "transfers.json").write_text("damaged test queue")
    start()
    check_startup_size()
    assert execute("return document.querySelector('#app').dataset.colorTheme;") == 'github-dark-dimmed', 'Selected theme survives restart'
    wait(lambda: execute("return document.body.textContent.includes('Start session');"), "restored dormant panes")
    assert not execute("return document.body.textContent.includes(arguments[0]);", expected), "Private scrollback should not be restored by default"
    assert "retained" in invoke("transfer_queue_notice")
    assert any(path.read_text() == "damaged test queue" for path in data_dir.glob("transfers-recovery-*.json"))
    check("damaged transfer queue is retained without blocking native terminal startup")
    screenshot("restored-layout.png")
    check("all native windows save and reopen dormant without output or command replay")
    (artifacts / "results.json").write_text(json.dumps({"backend": os.environ.get("GDK_BACKEND"), "checks": checks}, indent=2))
finally:
    if session:
        try:
            screenshot("final.png")
            request("DELETE", f"/session/{session}")
        except Exception as error:
            print(f"Cleanup observation: {error}", file=sys.stderr)
    trap.close()
    if fixture:
        fixture.terminate()
        try:
            fixture.wait(timeout=10)
        except subprocess.TimeoutExpired:
            fixture.kill()
            fixture.wait()
    if fixture_log:
        fixture_log.close()
    try:
        os.killpg(driver.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        driver.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(driver.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        driver.wait()
    log.close()
