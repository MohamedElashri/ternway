"""Exercise sidebar layout with native WebKit pointer/keyboard events and real config writes.

Call run(globals()) from native-gui-smoke.py after connecting the SSH fixture, while
its remote workspace is active. The harness owns the config, window, and terminals.
"""


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
        return g['read']("return window.__sidebarReviewMain===document.querySelector('.content-area') && window.__sidebarReviewTerminal===document.querySelector('.terminal-host');")

    try:
        if g['shown']('.modal'):
            g['click']('[data-action="close-modal"]')
        assert g['shown']('[data-sidebar="tools"]'), 'run sidebar review on an active remote workspace'
        g['click']('[data-view="terminal"]')
        g['wait'](lambda: g['shown']('.terminal-host'), 'remote terminal ready for sidebar layout review')
        g['request']('POST', f"/session/{g['session']}/window/rect", {'width': 1200, 'height': 780})
        layout('sidebar-width = 260\nsidebar-collapsed = false\ntools-sidebar-width = 190\ntools-sidebar-collapsed = false\n')
        g['wait'](lambda: width('connections') == 260 and width('tools') == 190, 'external sidebar config applies live')
        g['execute']("window.__sidebarReviewMain=document.querySelector('.content-area');window.__sidebarReviewTerminal=document.querySelector('.terminal-host');return true;")
        before = path.read_text()
        pointer('connections', 70, release=False)
        assert path.read_text() == before, 'resize must not write config during pointer movement'
        assert width('connections') == 330
        g['request']('POST', f"/session/{g['session']}/actions", {'actions': [{'type': 'pointer', 'id': 'sidebar-pointer', 'parameters': {'pointerType': 'mouse'}, 'actions': [{'type': 'pointerUp', 'button': 0}]}]})
        g['wait'](lambda: 'sidebar-width = 330' in path.read_text(), 'pointer width committed to main config')
        assert retained(), 'pointer resizing replaced content or terminal DOM'

        focus_handle('tools')
        key('\ue014')  # ArrowRight
        g['wait'](lambda: width('tools') == 200 and 'tools-sidebar-width = 200' in path.read_text(), 'keyboard separator width persists')
        focus_handle('connections')
        key('\ue014', up=False)
        assert width('connections') == 340
        key('\ue00c')  # Escape rolls back the pending key gesture.
        key('\ue014', down=False)
        assert width('connections') == 330 and 'sidebar-width = 330' in path.read_text()
        assert retained(), 'keyboard resizing replaced terminal DOM'
        g['check']('both native separators resize with pointer and keyboard, commit only on release, and Escape rolls back')

        g['click']('[data-sidebar-toggle="connections"]')
        g['click']('[data-sidebar-toggle="tools"]')
        g['wait'](lambda: compact('connections') and compact('tools') and 'sidebar-collapsed = true' in path.read_text() and 'tools-sidebar-collapsed = true' in path.read_text(), 'independent compact choices persist')
        assert width('connections') == 48 and width('tools') == 48
        assert g['shown']('[data-sidebar-compact] [data-action="add-server"]')
        assert g['shown']('[data-sidebar-compact] [data-action="credential-settings"]')
        assert g['shown']('[data-sidebar="tools"] [data-view="terminal"]')
        assert not g['shown']('[data-sidebar-expanded] input')
        assert g['read']("return document.querySelector('[data-sidebar-resize=connections]').tabIndex===-1 && document.querySelector('[data-sidebar-toggle=connections]').getAttribute('aria-expanded')==='false';")
        g['click']('[data-sidebar-search]')
        g['wait'](lambda: not compact('connections') and g['read']("return document.activeElement?.dataset.field==='server-search';"), 'compact search expands and focuses the connection search')
        assert compact('tools') and retained()
        g['click']('[data-sidebar-toggle="tools"]')
        g['click']('[data-sidebar-reset="connections"]')
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
    finally:
        # Restore only this harness's isolated file and window; leave no changed preferences.
        path.write_text(original)
        g['request']('POST', f"/session/{g['session']}/window/rect", rect)
        g['execute']("delete window.__sidebarReviewMain;delete window.__sidebarReviewTerminal;return true;")
