"""Exercise sidebar layout with native WebKit pointer/keyboard events and real config writes.

Call run(globals()) from native-gui-smoke.py after connecting the SSH fixture, while
its remote workspace is active. The harness owns the config, window, and terminals.
"""
import json
import sys


def painted_layout(g, test, description):
    g['wait'](test, description)
    # Native hit testing can lag a DOM grid change. Observe the new geometry,
    # then let it reach the compositor before delivering the next click.
    g['request']('POST', f"/session/{g['session']}/execute/async", {'script': "const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));", 'args': []}, idempotent=True)


def prepare_restart(g):
    """Use the suite's existing coordinated restart to verify durable preferences."""
    path = g['config'] / 'config'
    original = path.read_text()
    # The library restore test removes the authenticated fixture profile. Use an
    # owned surviving profile only as an inert saved-workspace reference.
    g['sidebar_restart_server_id'] = g['invoke']('get_state')['servers'][0]['id']
    keys = {'sidebar-width', 'sidebar-collapsed', 'tools-sidebar-width', 'tools-sidebar-collapsed'}
    base = '\n'.join(line for line in original.splitlines() if line.partition('=')[0].strip() not in keys) + '\n'
    path.write_text(base + 'sidebar-width = 310\nsidebar-collapsed = true\ntools-sidebar-width = 205\ntools-sidebar-collapsed = true\n')
    try:
        g['wait'](lambda: g['read']("return document.querySelector('[data-sidebar=connections]')?.dataset.compact==='true';"), 'compact connection preference applies before restart')
    except Exception:
        path.write_text(original)
        raise
    return original


def seed_restart_layout(g, data_dir):
    """Add an inert remote pane without connecting or starting a process."""
    path = data_dir / 'session.json'
    layout = json.loads(path.read_text())
    workspace, pane = 'qa-sidebar-dormant', 'qa-sidebar-dormant-pane'
    layout.setdefault('workspaces', []).append({'id': workspace, 'serverId': g['sidebar_restart_server_id'], 'label': 'Sidebar restore QA'})
    layout['groups'].append({'workspace': workspace, 'title': 'Sidebar restore QA', 'root': {'kind': 'leaf', 'terminalId': pane}, 'focusedId': pane, 'panes': {pane: {'snapshot': 'Dormant sidebar QA; no process started'}}})
    # Keep the existing active workspace/group and its history-marker assertion.
    path.write_text(json.dumps(layout))


def verify_restart(g):
    def desktop():
        g['request']('POST', f"/session/{g['session']}/window/rect", {'width': 1200, 'height': 780})
        painted_layout(g, lambda: g['read']("return Math.abs(innerWidth-1200)<=2;"), 'restored window has room for preferred sidebar widths')

    try:
        desktop()
        assert g['read']("return document.querySelector('[data-sidebar=connections]')?.dataset.compact==='true';"), 'connection collapse preference lost on restart'
        g['click']('[data-sidebar-toggle="connections"]')
        painted_layout(g, lambda: g['read']("return Math.round(document.querySelector('[data-sidebar=connections]').getBoundingClientRect().width)===310;"), 'preferred connection width survives restart')
        # A restored remote workspace remains dormant; selecting it must not start a shell.
        handles = g['request']('GET', f"/session/{g['session']}/window/handles")
        found = False
        for handle in handles:
            g['request']('POST', f"/session/{g['session']}/window", {'handle': handle})
            desktop()
            if g['shown']('.workspace-tab:not(.workspace-tab-local)[data-workspace-tab]'):
                g['click']('.workspace-tab:not(.workspace-tab-local)[data-workspace-tab]')
                painted_layout(g, lambda: g['shown']('[data-sidebar="tools"]'), 'dormant remote workspace tool rail reaches the native display')
                assert g['read']("return document.querySelector('[data-sidebar=tools]').dataset.compact==='true';"), 'tool collapse preference lost on restart'
                g['click']('[data-sidebar-toggle="tools"]')
                painted_layout(g, lambda: g['read']("return document.querySelector('[data-sidebar=tools]').dataset.compact==='false' && Math.round(document.querySelector('[data-sidebar=tools]').getBoundingClientRect().width)===205;"), 'preferred tool width survives restart')
                ids = g['read']("return [...document.querySelectorAll('.term-tab')].map(el=>el.dataset.terminalTab);")
                assert all(value == 'closed' for value in g['invoke']('terminal_activities', sessionIds=ids).values()), 'sidebar persistence check started a dormant process'
                found = True
                break
        assert found, 'restored SSH workspace required to verify tool rail persistence'
        g['screenshot']('sidebar-preferences-restored.png')
        g['check']('independent sidebar widths and compact preferences survive coordinated quit and restart')
    except Exception:
        try:
            g['screenshot']('sidebar-restart-failure.png')
            evidence = {'config': (g['config'] / 'config').read_text(), 'dom': g['read']("return {width:innerWidth,height:innerHeight,panels:[...document.querySelectorAll('[data-sidebar]')].map(el=>({side:el.dataset.sidebar,compact:el.dataset.compact,width:el.getBoundingClientRect().width})),error:document.querySelector('.app-toast')?.textContent};")}
            (g['artifacts'] / 'sidebar-restart-failure.json').write_text(json.dumps(evidence, indent=2))
        except Exception as capture_error:
            print(f'Sidebar restart evidence observation: {capture_error}', file=sys.stderr)
        raise


def run(g):
    path = g['config'] / 'config'
    original = path.read_text()
    rect = g['request']('GET', f"/session/{g['session']}/window/rect")
    keys = {'sidebar-width', 'sidebar-collapsed', 'tools-sidebar-width', 'tools-sidebar-collapsed'}
    base = '\n'.join(line for line in original.splitlines() if line.partition('=')[0].strip() not in keys) + '\n'

    def layout(extra):
        path.write_text(base + extra)

    def width(side):
        return g['read']("return Math.round(document.querySelector('[data-sidebar='+arguments[0]+']').getBoundingClientRect().width);", side)

    def compact(side):
        return g['read']("return document.querySelector('[data-sidebar='+arguments[0]+']')?.dataset.compact==='true';", side)

    def key(value, down=True, up=True):
        actions = ([{'type': 'keyDown', 'value': value}] if down else []) + ([{'type': 'keyUp', 'value': value}] if up else [])
        g['request']('POST', f"/session/{g['session']}/actions", {'actions': [{'type': 'key', 'id': 'sidebar-keyboard', 'actions': actions}]})

    def focus_handle(side):
        g['execute']("document.querySelector('[data-sidebar-resize='+arguments[0]+']').focus();return true;", side, idempotent=True)

    def pointer(side, delta, release=True):
        point = g['read']("const r=document.querySelector('[data-sidebar-resize='+arguments[0]+']').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+70)};", side)
        actions = [{'type': 'pointerMove', 'x': point['x'], 'y': point['y']}, {'type': 'pointerDown', 'button': 0}, {'type': 'pointerMove', 'duration': 200, 'x': point['x'] + delta, 'y': point['y']}]
        if release:
            actions.append({'type': 'pointerUp', 'button': 0})
        g['request']('POST', f"/session/{g['session']}/actions", {'actions': [{'type': 'pointer', 'id': 'sidebar-pointer', 'parameters': {'pointerType': 'mouse'}, 'actions': actions}]})

    def retained():
        return g['read']("return window.__sidebarReviewMain===document.querySelector('.content-area') && window.__sidebarReviewTerminal===document.querySelector('.terminal-host:not([hidden])');")

    try:
        if g['shown']('.modal'):
            g['click']('[data-action="close-modal"]')
        assert g['shown']('[data-sidebar="tools"]'), 'run sidebar review on an active remote workspace'
        g['click']('[data-view="terminal"]')
        g['wait'](lambda: g['shown']('.terminal-host'), 'remote terminal ready for sidebar layout review')
        g['request']('POST', f"/session/{g['session']}/window/rect", {'width': 1200, 'height': 780})
        layout('sidebar-width = 260\nsidebar-collapsed = false\ntools-sidebar-width = 190\ntools-sidebar-collapsed = false\n')
        g['wait'](lambda: width('connections') == 260 and width('tools') == 190, 'external sidebar config applies live')
        g['execute']("window.__sidebarReviewMain=document.querySelector('.content-area');window.__sidebarReviewTerminal=document.querySelector('.terminal-host:not([hidden])');return true;")
        before = path.read_text()
        pointer('connections', 70, release=False)
        assert path.read_text() == before, 'resize must not write config during pointer movement'
        assert width('connections') == 330
        g['request']('POST', f"/session/{g['session']}/actions", {'actions': [{'type': 'pointer', 'id': 'sidebar-pointer', 'parameters': {'pointerType': 'mouse'}, 'actions': [{'type': 'pointerUp', 'button': 0}]}]})
        g['wait'](lambda: 'sidebar-width = 330' in path.read_text(), 'pointer width committed to main config')
        assert retained(), 'pointer resizing replaced content or terminal DOM'

        before = path.read_text()
        pointer('tools', 10, release=False)
        assert width('tools') == 200 and path.read_text() == before, 'tool separator wrote config before pointer release'
        g['request']('POST', f"/session/{g['session']}/actions", {'actions': [{'type': 'pointer', 'id': 'sidebar-pointer', 'parameters': {'pointerType': 'mouse'}, 'actions': [{'type': 'pointerUp', 'button': 0}]}]})
        g['wait'](lambda: 'tools-sidebar-width = 200' in path.read_text(), 'tool pointer width committed to main config')

        focus_handle('tools')
        key('\ue014')  # ArrowRight
        g['wait'](lambda: width('tools') == 210 and 'tools-sidebar-width = 210' in path.read_text(), 'keyboard separator width persists')
        focus_handle('connections')
        key('\ue014', up=False)
        assert width('connections') == 340
        key('\ue00c')  # Escape rolls back the pending key gesture.
        key('\ue014', down=False)
        assert width('connections') == 330 and 'sidebar-width = 330' in path.read_text()
        focus_handle('connections')
        key('\ue014')
        g['wait'](lambda: width('connections') == 340 and 'sidebar-width = 340' in path.read_text(), 'connection keyboard separator width persists')
        assert retained(), 'keyboard resizing replaced terminal DOM'
        g['check']('both native separators resize with pointer and keyboard, commit only on release, and Escape rolls back')

        observations = []
        for side in ['connections', 'tools']:
            g['click'](f'[data-sidebar-toggle="{side}"]')
            painted_layout(g, lambda: compact(side) and width(side) == 48, f'{side} compact geometry reaches the native display')
            observations.append({'side': side, 'dom': g['read']("return [...document.querySelectorAll('[data-sidebar]')].map(el=>({side:el.dataset.sidebar,compact:el.dataset.compact,width:el.getBoundingClientRect().width}));"), 'config': path.read_text()})
        (g['artifacts'] / 'sidebar-toggle-observations.json').write_text(json.dumps(observations, indent=2))
        g['wait'](lambda: compact('connections') and compact('tools') and 'sidebar-collapsed = true' in path.read_text() and 'tools-sidebar-collapsed = true' in path.read_text(), 'independent compact choices persist')
        assert width('connections') == 48 and width('tools') == 48
        assert g['shown']('[data-sidebar-compact] [data-action="add-server"]')
        assert g['shown']('[data-sidebar-compact] [data-action="credential-settings"]')
        assert g['shown']('[data-sidebar="tools"] [data-view="terminal"]')
        assert not g['shown']('[data-sidebar-expanded] input')
        assert g['read']("return document.querySelector('[data-sidebar-resize=connections]').tabIndex===-1 && document.querySelector('[data-sidebar-toggle=connections]').getAttribute('aria-expanded')==='false';")
        g['screenshot']('sidebar-desktop-compact.png')
        g['click']('[data-sidebar-search]')
        painted_layout(g, lambda: not compact('connections') and g['read']("return document.activeElement?.dataset.field==='server-search';"), 'compact search expands and focuses the connection search')
        assert compact('tools') and retained()
        g['click']('[data-sidebar-toggle="tools"]')
        painted_layout(g, lambda: not compact('tools'), 'tools rail expands before resetting widths')
        g['click']('[data-sidebar-reset="connections"]')
        painted_layout(g, lambda: width('connections') == 260, 'connection width resets before moving to the tool reset control')
        g['click']('[data-sidebar-reset="tools"]')
        g['wait'](lambda: width('connections') == 260 and width('tools') == 190 and 'sidebar-width = 260' in path.read_text() and 'tools-sidebar-width = 190' in path.read_text(), 'GUI width reset persists defaults')
        assert retained()
        g['check']('compact rails retain expand, search, new connection, Settings and tool navigation without replacing workspace DOM')

        g['request']('POST', f"/session/{g['session']}/window/rect", {'width': 640, 'height': 480})
        geometry = g['read']("const main=document.querySelector('.main-area').getBoundingClientRect(), app=document.querySelector('.app-shell');return {main:main.width,right:main.right,viewport:innerWidth,overflow:app.scrollWidth-app.clientWidth};")
        assert geometry['main'] >= 319 and geometry['right'] <= geometry['viewport'] + 1, geometry
        assert geometry['overflow'] <= 1, geometry
        assert width('connections') >= 160 and width('tools') >= 140
        g['screenshot']('sidebar-narrow-expanded.png')
        g['request']('POST', f"/session/{g['session']}/window/rect", {'width': 1200, 'height': 780})
        g['wait'](lambda: width('connections') == 260 and width('tools') == 190, 'preferred widths recover on desktop')
        assert retained()
        g['screenshot']('sidebar-desktop-expanded.png')
        g['check']('640px native window retains a 320px workspace and restores preferred sidebar widths when enlarged')

        # Settings navigation renders the application shell. The connection list
        # and its rows should remain mounted when their model has not changed.
        g['execute']("window.__sidebarReviewList=document.querySelector('.server-list');window.__sidebarReviewRows=[...document.querySelectorAll('.server-item')];return true;")
        g['click']('[data-action="credential-settings"]')
        g['wait'](lambda: g['shown']('.modal-settings'), 'Settings renders over the remote workspace')
        g['click']('[data-settings-page="terminal"]')
        g['click']('[data-action="close-modal"]')
        assert g['read']("return window.__sidebarReviewList===document.querySelector('.server-list') && window.__sidebarReviewRows.length>0 && window.__sidebarReviewRows.every(row=>row===document.querySelector('.server-item[data-server-id=\"'+CSS.escape(row.dataset.serverId)+'\"]'));"), 'unrelated full renders replaced connection rows'
        assert g['read']("return window.__sidebarReviewTerminal===document.querySelector('.terminal-host:not([hidden])');"), 'Settings replaced the active terminal'
        g['check']('Settings open, page navigation and close retain existing connection rows and the active terminal')
    except Exception:
        # Capture the live failure before restoring the isolated preferences.
        try:
            g['screenshot']('sidebar-failure.png')
            evidence = {'config': path.read_text(), 'dom': g['read']("return {panels:[...document.querySelectorAll('[data-sidebar]')].map(el=>({side:el.dataset.sidebar,compact:el.dataset.compact,width:el.getBoundingClientRect().width})),text:document.querySelector('.app-toast')?.textContent,error:document.querySelector('.error-banner,.inline-error')?.textContent};")}
            (g['artifacts'] / 'sidebar-failure.json').write_text(json.dumps(evidence, indent=2))
        except Exception as capture_error:
            print(f'Sidebar evidence observation: {capture_error}', file=sys.stderr)
        raise
    finally:
        # Release partial gestures even on assertion failure. Restore the owned
        # file/window independently, preserving any original test failure.
        failing = sys.exc_info()[0] is not None
        cleanup = [
            lambda: g['request']('DELETE', f"/session/{g['session']}/actions"),
            lambda: path.write_text(original),
            lambda: g['request']('POST', f"/session/{g['session']}/window/rect", rect),
            lambda: g['execute']("delete window.__sidebarReviewMain;delete window.__sidebarReviewTerminal;delete window.__sidebarReviewList;delete window.__sidebarReviewRows;return true;"),
        ]
        errors = []
        for restore in cleanup:
            try:
                restore()
            except Exception as error:
                errors.append(error)
        if errors:
            if not failing:
                raise errors[0]
            print(f'Sidebar cleanup observations: {errors}', file=sys.stderr)
