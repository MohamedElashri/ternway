"""Exercise configuration persistence, conflicts and profile inheritance in native WebKit."""
def run(g):
    config_file = g['config'] / 'config'
    original = config_file.read_text()
    profile_name = 'CI GUI profile'
    profile_file = g['config'] / 'profiles' / profile_name

    def open_settings():
        if not g['shown']('.modal-settings'):
            g['click']('[data-action="credential-settings"]')
        g['click']('[data-settings-page="terminal"]')
        g['wait'](lambda: g['shown']('[data-form="config-settings"]'), 'configuration GUI ready')

    def expand_groups():
        g['execute']("document.querySelectorAll('.config-setting-group').forEach(el=>el.open=true);return true;", idempotent=True)

    def value(key):
        return g['read']("return [...document.querySelectorAll('[data-config-key]')].find(el=>el.dataset.configKey===arguments[0])?.value;", key)

    def set_value(key, contents):
        expand_groups()
        lines = str(contents).split('\n')
        selector = f'[data-config-key="{key}"]'
        g['type_into'](selector, lines[0])
        # WebKit drops literal LF in send-keys for ordinary textareas. Use the
        # same Enter key a person uses, preserving the actual input path.
        for line in lines[1:]:
            g['request']('POST', f"/session/{g['session']}/actions", {'actions': [{'type': 'key', 'id': 'config-newline', 'actions': [{'type': 'keyDown', 'value': '\ue007'}, {'type': 'keyUp', 'value': '\ue007'}]}]})
            if line:
                target = g['element'](selector)
                g['request']('POST', f"/session/{g['session']}/element/{target}/value", {'text': line})

    def save():
        g['click']('[data-form="config-settings"] button[type="submit"]')

    def saved():
        # Watcher reload notifications can replace the success toast immediately.
        # The editor returning to a clean, enabled form is the persistent signal.
        g['wait'](lambda: g['read']("return document.querySelector('[data-config-notice]')?.textContent.startsWith('Changes apply when saved.') && !document.querySelector('[data-form=config-settings] button[type=submit]')?.disabled;"), 'settings saved')
        if g['shown']('[data-action="dismiss-toast"]'):
            g['click']('[data-action="dismiss-toast"]')

    def reload_settings(expect_confirm=False):
        g['click']('[data-action="config-discard"]')
        if expect_confirm:
            g['wait'](lambda: g['shown']('[data-action="accept-app-dialog"]'), 'discard confirmation')
            g['click']('[data-action="accept-app-dialog"]')
        g['wait'](lambda: g['shown']('[data-form="config-settings"]') and g['read']("return document.querySelector('[data-config-notice]')?.textContent.startsWith('Changes apply when saved.');"), 'settings reloaded')

    try:
        open_settings()
        reload_settings()
        original_env = value('env') or ''
        original_palette = value('palette') or ''
        changed_env = original_env + ('\n' if original_env else '') + 'TERNWAY_GUI_CONFIG_TEST=one=two'
        changed_palette = original_palette + ('\n' if original_palette else '') + '42=#12abef'
        set_value('font-size', 16)
        set_value('env', changed_env)
        set_value('palette', changed_palette)
        save()
        saved()
        persisted = config_file.read_text()
        assert 'font-size = 16' in persisted, persisted
        assert 'env = TERNWAY_GUI_CONFIG_TEST=one=two' in persisted, persisted
        assert 'palette = 42=#12abef' in persisted, persisted
        assert value('font-size') == '16'
        assert 'TERNWAY_GUI_CONFIG_TEST=one=two' in value('env')
        assert '42=#12abef' in value('palette')
        g['screenshot']('config-gui-saved.png')
        g['check']('GUI font, environment and palette changes persist to config and reload into their controls')

        # A parser error must keep the draft editable and leave the disk file untouched.
        before_invalid = config_file.read_text()
        set_value('env', changed_env + '\nNOT_AN_ASSIGNMENT')
        save()
        g['wait'](lambda: g['read']("return document.querySelector('[data-config-notice]')?.textContent.includes('invalid');"), 'invalid environment rejected')
        assert config_file.read_text() == before_invalid
        assert 'NOT_AN_ASSIGNMENT' in value('env')
        g['check']('invalid GUI settings retain the draft without changing the config file')
        reload_settings(expect_confirm=True)

        # An external write while a GUI draft is dirty must produce a conflict,
        # keep the typed value, and preserve the external file contents.
        set_value('font-size', 18)
        external = config_file.read_text() + '\n# external GUI conflict fixture\nfont-size = 19\n'
        config_file.write_text(external)
        g['wait'](lambda: any(entry['key'] == 'font-size' and entry['value'] == '19' for entry in g['invoke']('load_config')['entries']), 'external config visible to backend')
        save()
        g['wait'](lambda: g['read']("return /changed outside|changed while saving/i.test(document.querySelector('[data-config-notice]')?.textContent||'');"), 'external write conflict shown')
        assert config_file.read_text() == external
        assert value('font-size') == '18'
        reload_settings(expect_confirm=True)
        g['wait'](lambda: value('font-size') == '19', 'reload adopts external value')
        g['check']('external file edits conflict with a dirty GUI draft and reload adopts the external value')

        # Creating a profile must return to the editor rather than leave it closed.
        g['click']('[data-action="config-profile-create"]')
        g['type_into']('[data-form="input-prompt"] [name="value"]', profile_name)
        g['click']('[data-form="input-prompt"] button[type="submit"]')
        g['wait'](lambda: g['shown']('[data-form="config-settings"]') and g['read']("return document.querySelector('[data-field=config-profile]')?.value; ") == profile_name, 'new profile selected in Settings')
        assert profile_file.exists()
        assert value('font-size') == '19', 'new profile did not inherit main font size'
        assert 'TERNWAY_GUI_CONFIG_TEST=one=two' in value('env')
        set_value('font-size', 21)
        set_value('env', 'TERNWAY_GUI_PROFILE_ONLY=present')
        save()
        saved()
        assert 'font-size = 21' in profile_file.read_text()
        assert 'font-size = 19' in config_file.read_text()
        assert value('font-size') == '21'
        assert value('env') == 'TERNWAY_GUI_PROFILE_ONLY=present'

        # Reset removes the profile override; it must not write a copy of the
        # inherited value, so future main-config edits continue to flow through.
        expand_groups()
        g['click']('[data-config-reset="font-size"]')
        g['click']('[data-config-reset="env"]')
        save()
        saved()
        assert not any(line.strip().startswith('font-size') or line.strip().startswith('env =') for line in profile_file.read_text().splitlines())
        assert value('font-size') == '19'
        assert 'TERNWAY_GUI_CONFIG_TEST=one=two' in value('env')
        g['screenshot']('config-gui-profile-inheritance.png')
        g['click']('[data-action="config-profile-delete"]')
        g['click']('[data-action="accept-app-dialog"]')
        g['wait'](lambda: not profile_file.exists() and g['read']("return document.querySelector('[data-field=config-profile]')?.value===''"), 'profile deleted and main config selected')
        g['check']('GUI profiles create, inherit main settings, save overrides, reset inheritance and delete without altering main config')
    finally:
        # Only fixture files are touched. Restore the native suite's prompt and
        # terminal behavior before any later checks execute.
        config_file.write_text(original)
        if profile_file.exists():
            profile_file.unlink()
        if g['shown']('.modal-settings'):
            g['click']('[data-action="close-modal"]')
        g['invoke']('load_config')
