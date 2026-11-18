"""Review the source-first import UI and refresh edited configs in native WebKit."""

def run(h):
    source = h['root'] / 'import-review.conf'
    marker = h['root'] / 'import-command-must-not-run'
    first_key = h['root'] / 'first-key'
    next_key = h['root'] / 'next-key'
    folder = 'Import review personal folder'
    original = h['invoke']('get_state')
    original_ids = {server['id'] for server in original['servers']}
    original_folders = set(original.get('connectionFolders', []))
    rect = h['request']('GET', f"/session/{h['session']}/window/rect")
    original_theme = h['read']("return document.querySelector('#app').dataset.theme;")

    def write_config(copied=False, changed=False, removed=False):
        text = '' if removed else 'Host ci-import-shell\n  HostName first.example.invalid\n  User qa\n'
        text += f'Host ci-import-advanced\n  HostName internal.example.invalid\n  ProxyCommand touch {marker}\nHost ci-import-git\n  HostName github.com\n  User git\n'
        if copied and not removed:
            host, user, port, key = ('updated.example.invalid', 'deploy', 2302, next_key) if changed else ('copied.example.invalid', 'qa', 2201, first_key)
            text += f'Host ci-import-copied\n  HostName {host}\n  User {user}\n  Port {port}\n  IdentityFile {key}\n'
        source.write_text(text)

    def ready():
        return h['read']("return !document.querySelector('[data-import-review]').hidden && !document.querySelector('[data-import-review]').disabled;")

    def complete(text):
        h['wait'](lambda: h['read']("return document.querySelector('[data-import-error]')?.textContent.includes(arguments[0]) && document.querySelector('[data-import-progress]').value===document.querySelector('[data-import-progress]').max;", text), text)

    def choose_only(query):
        h['type_into']('[data-field="import-search"]', '')
        h['click']('[data-action="clear-import-hosts"]')
        h['type_into']('[data-field="import-search"]', query)
        h['click']('[data-action="select-import-hosts"]')

    def select_mode(mode):
        h['execute']("const select=document.querySelector('[name=importMode]');select.value=arguments[0];select.dispatchEvent(new Event('change',{bubbles:true}));return true;", mode)

    def fit_and_capture(name):
        h['execute']("document.querySelector('[data-form=ssh-import]').scrollTop=0;return true;")
        geometry = h['read']("const m=document.querySelector('.modal-ssh-import').getBoundingClientRect(),f=document.querySelector('.modal-ssh-import .modal-actions').getBoundingClientRect();return {left:m.left,right:m.right,bottom:m.bottom,footer:f.bottom,width:innerWidth,height:innerHeight};")
        assert geometry['left'] >= -1 and geometry['right'] <= geometry['width'] + 1 and geometry['bottom'] <= geometry['height'] + 1, geometry
        assert geometry['footer'] <= geometry['height'] + 1, geometry
        visible = h['read']("const list=document.querySelector('[data-import-hosts]').getBoundingClientRect(),footer=document.querySelector('.modal-ssh-import .modal-actions').getBoundingClientRect(),head=document.querySelector('.modal-ssh-import .modal-head').getBoundingClientRect(),destination=document.querySelector('[data-import-destination]');return {list:Math.min(list.bottom,footer.top)-Math.max(list.top,head.bottom),destination:destination.hidden?true:(destination.getBoundingClientRect().top>=footer.top-1&&destination.getBoundingClientRect().bottom<=innerHeight+1)};")
        assert visible['list'] >= 56, visible
        assert visible['destination'], 'new-host destination must stay visible beside the primary action'
        h['screenshot'](name)

    write_config()
    try:
        h['request']('POST', f"/session/{h['session']}/window/rect", {'width': 1200, 'height': 780})
        h['click']('[data-action="import-ssh-config"]')
        assert h['read']("return !document.querySelector('[data-import-source]').hidden && document.querySelector('[data-import-review]').hidden;")
        h['screenshot']('ssh-import-choose-file.png')
        h['type_into']('[data-form="ssh-import"] [name="path"]', str(source))
        h['click']('[data-action="load-ssh-config"]')
        h['wait'](ready, 'new import review ready')
        assert h['read']("return document.querySelectorAll('.import-host').length===3 && document.querySelectorAll('.import-host input:checked').length===2;")
        assert h['read']("return document.querySelector('[name=folder]').value==='';"), 'import destination must be the permanent default folder'
        # Search changes visible rows, not the existing selection.
        h['type_into']('[data-field="import-search"]', 'advanced')
        h['click']('[data-action="clear-import-hosts"]')
        h['type_into']('[data-field="import-search"]', 'git')
        h['click']('[data-action="select-import-hosts"]')
        assert h['read']("return document.querySelectorAll('.import-host input:checked').length===2;")
        h['click']('[data-action="clear-import-hosts"]')
        h['type_into']('[data-field="import-search"]', '')
        fit_and_capture('ssh-import-review-desktop.png')
        h['execute']("document.querySelector('[data-action=theme]').click();return true;")
        h['wait'](lambda: h['read']("return document.querySelector('#app').dataset.theme!==arguments[0];", original_theme), 'alternate import theme')
        fit_and_capture('ssh-import-review-alternate-theme.png')
        h['execute']("document.querySelector('[data-action=theme]').click();return true;")
        h['wait'](lambda: h['read']("return document.querySelector('#app').dataset.theme===arguments[0];", original_theme), 'restore import theme')
        h['request']('POST', f"/session/{h['session']}/window/rect", {'width': 640, 'height': 480})
        fit_and_capture('ssh-import-review-narrow.png')
        h['request']('POST', f"/session/{h['session']}/window/rect", {'width': 1200, 'height': 780})
        h['click']('[data-form="ssh-import"] button[type="submit"]')
        complete('1 added · 0 updated')
        assert h['shown']('[data-import-done]') and not h['shown']('[data-form=ssh-import] button[type=submit]')
        h['click']('[data-action="select-all-import-hosts"]')
        h['click']('[data-form="ssh-import"] button[type="submit"]')
        complete('2 added · 0 updated')
        imported = {server['name']: server for server in h['invoke']('get_state')['servers'] if server['id'] not in original_ids}
        assert len(imported) == 3 and all(server['groupName'] is None for server in imported.values())
        assert not marker.exists(), 'review/import executed a configured command'
        # Re-reading keeps source identities and exposes a first-class update action.
        source.write_text(source.read_text().replace('first.example.invalid', 'new.example.invalid'))
        h['click']('[data-action="reload-ssh-config"]')
        h['wait'](ready, 'existing imports reloaded')
        h['wait'](lambda: h['read']("return document.querySelector('[data-import-intent=updates]').getAttribute('aria-pressed')==='true';"), 'update action selected for an already imported file')
        choose_only('ci-import-shell')
        assert h['read']("return document.querySelector('.import-host:not([hidden])').textContent.includes('new.example.invalid');")
        h['click']('[data-form="ssh-import"] button[type="submit"]')
        complete('0 added · 1 updated')
        assert {server['id'] for server in h['invoke']('get_state')['servers']} == original_ids | {server['id'] for server in imported.values()}
        # Add a copied connection, then reopen with the default OpenSSH new-host
        # option. Refresh must retain the saved copied type and its exact ID.
        write_config(copied=True)
        h['click']('[data-action="reload-ssh-config"]')
        h['wait'](ready, 'new copied host discovered')
        h['click']('[data-import-intent="new"]')
        select_mode('managed')
        h['click']('[data-form="ssh-import"] button[type="submit"]')
        complete('1 added · 0 updated')
        copied = next(server for server in h['invoke']('get_state')['servers'] if server['name'] == 'ci-import-copied')
        personal = dict(copied)
        personal.update(name='My copied host', groupName=folder, notes='Keep these notes', tags=['personal'], favorite=True)
        h['invoke']('save_server', draft=personal)
        h['click']('[data-action="close-modal"]')
        write_config(copied=True, changed=True)
        h['click']('[data-action="import-ssh-config"]')
        h['type_into']('[data-form="ssh-import"] [name="path"]', str(source))
        h['click']('[data-action="load-ssh-config"]')
        h['wait'](ready, 'copied import ready for refresh')
        choose_only('ci-import-copied')
        fit_and_capture('ssh-import-update-preview.png')
        h['click']('[data-form="ssh-import"] button[type="submit"]')
        complete('0 added · 1 updated')
        updated = next(server for server in h['invoke']('get_state')['servers'] if server['id'] == copied['id'])
        assert (updated['host'], updated['username'], updated['port'], updated['keyPath'], updated['authMethod']) == ('updated.example.invalid', 'deploy', 2302, str(next_key), 'privateKey'), updated
        assert (updated['name'], updated['groupName'], updated['notes'], updated['tags'], updated['favorite']) == ('My copied host', folder, 'Keep these notes', ['personal'], True)
        assert len(h['invoke']('get_state')['servers']) == len(original_ids) + 4
        write_config(removed=True)
        h['click']('[data-action="reload-ssh-config"]')
        h['wait'](ready, 'removed source aliases reviewed')
        assert h['read']("return !document.querySelector('[data-import-missing]').hidden && document.querySelector('[data-import-missing]').textContent.includes('ci-import-copied');")
        assert len(h['invoke']('get_state')['servers']) == len(original_ids) + 4
        assert not marker.exists()
        h['click']('[data-action="close-modal"]')
        h['check']('source-first import supports whole/selected hosts, defaults to the permanent folder, refreshes copied/linked imports without duplicates, preserves personal metadata and keeps removed aliases')
    finally:
        if h['read']("return document.querySelector('#app').dataset.theme!==arguments[0];", original_theme):
            h['execute']("document.querySelector('[data-action=theme]').click();return true;")
        for server in h['invoke']('get_state')['servers']:
            if server['id'] not in original_ids:
                h['invoke']('delete_server', serverId=server['id'])
        for path in sorted(set(h['invoke']('get_state').get('connectionFolders', [])) - original_folders, key=len, reverse=True):
            h['invoke']('delete_connection_folder', path=path)
        h['request']('POST', f"/session/{h['session']}/window/rect", rect)
