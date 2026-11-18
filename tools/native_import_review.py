"""Exercise the import picker and whole-file flow in the native WebKit application."""
def run(h):
    source = h['root'] / 'import-review.conf'
    marker = h['root'] / 'import-command-must-not-run'
    source.write_text(f'''Host ci-import-shell
  HostName 127.0.0.1
  User qa
Host ci-import-advanced
  HostName 127.0.0.1
  ProxyCommand touch {marker}
Host ci-import-git
  HostName github.com
  User git
''')
    original_ids = {server['id'] for server in h['invoke']('get_state')['servers']}
    try:
        h['click']('[data-action="import-ssh-config"]')
        h['type_into']('[data-form="ssh-import"] [name="path"]', str(source))
        h['click']('[data-action="load-ssh-config"]')
        h['wait'](lambda: h['read']("return document.querySelectorAll('.import-host').length===3 && !document.querySelector('[data-form=ssh-import] button[type=submit]').disabled;"), 'three SSH aliases ready')
        assert h['read']("return Array.from(document.querySelectorAll('.import-host input:checked')).length===1;")
        h['type_into']('[data-field="import-search"]', 'advanced')
        h['click']('[data-action="select-import-hosts"]')
        assert h['read']("return document.querySelectorAll('.import-host input:checked').length===2 && document.querySelectorAll('.import-host:not([hidden])').length===1;")
        h['click']('[data-action="clear-import-hosts"]')
        h['type_into']('[data-field="import-search"]', '')
        h['click']('[data-form="ssh-import"] button[type="submit"]')
        h['wait'](lambda: h['read']("return document.querySelector('[data-import-error]')?.textContent.includes('Imported 1 of 1');"), 'selected host imported')
        # Selects are enhanced by the app; dispatch their normal change path without
        # depending on WebDriver's platform-specific select popup support.
        h['execute']("const select=document.querySelector('[name=importScope]');select.value='all';select.dispatchEvent(new Event('change',{bubbles:true}));return true;")
        assert h['read']("return document.querySelector('[data-import-summary]').textContent.includes('2 of 3 hosts selected');")
        h['click']('[data-form="ssh-import"] button[type="submit"]')
        h['wait'](lambda: h['read']("return document.querySelector('[data-import-error]')?.textContent.includes('Imported 2 of 2');"), 'whole config imports remaining advanced and Git aliases')
        assert not marker.exists(), 'import executed a configured command'
        assert len(h['invoke']('get_state')['servers']) == len(original_ids) + 3
        h['screenshot']('ssh-import-whole-file.png')
        h['click']('[data-action="close-modal"]')
        h['click']('[data-action="import-ssh-config"]')
        h['type_into']('[data-form="ssh-import"] [name="path"]', str(source))
        h['click']('[data-action="load-ssh-config"]')
        h['wait'](lambda: h['read']("return document.querySelector('[data-import-error]')?.textContent.includes('3 aliases previously imported');"), 'duplicate reconciliation')
        h['execute']("const select=document.querySelector('[name=importScope]');select.value='all';select.dispatchEvent(new Event('change',{bubbles:true}));return true;")
        h['click']('[data-form="ssh-import"] button[type="submit"]')
        h['wait'](lambda: h['read']("return document.querySelector('[data-import-error]')?.textContent.includes('0 new, 3 reused');"), 'repeat whole import reuses existing profiles')
        assert len(h['invoke']('get_state')['servers']) == len(original_ids) + 3
        h['click']('[data-action="close-modal"]')
        h['check']('SSH import preserves filtered selections, imports whole files and advanced aliases without executing commands, and reuses existing profiles')
    finally:
        for server in h['invoke']('get_state')['servers']:
            if server['id'] not in original_ids:
                h['invoke']('delete_server', serverId=server['id'])
