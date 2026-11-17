"""Navigation, focus and geometry checks on the actual native settings window."""
def run(h):
    # Called while Settings is open. Every page must fit narrow and desktop layouts,
    # remain reachable by keyboard, and keep its footer available at a larger UI scale.
    for width,height in [(640,480),(1200,780)]:
        h['request']('POST',f"/session/{h['session']}/window/rect",{'width':width,'height':height})
        for page in ['appearance','terminal','connections','security','updates','about']:
            h['click'](f'[data-settings-page="{page}"]')
            result=h['read']("""const modal=document.querySelector('.modal-settings'),footer=document.querySelector('.settings-footer'),nav=document.querySelector('.settings-nav');
const r=modal.getBoundingClientRect(), f=footer.getBoundingClientRect(),n=nav.getBoundingClientRect();
return {sections:document.querySelectorAll('.settings-group').length,overflow:modal.scrollHeight-modal.clientHeight,left:r.left,right:r.right,footer:f.bottom,nav:n.top,width:innerWidth,height:innerHeight};""")
            assert result['sections']==1, (page,result)
            assert result['left']>=-1 and result['right']<=result['width']+1 and result['footer']<=result['height']+1 and result['nav']>=0, (page,result)
            assert result['overflow']<=1,(page,result)
            h['request']('POST',f"/session/{h['session']}/actions",{'actions':[{'type':'key','id':'ui-review','actions':[{'type':'keyDown','value':'\ue004'},{'type':'keyUp','value':'\ue004'}]}]})
            assert h['read']("return !!document.activeElement?.closest('.modal-settings');"), page
        h['screenshot'](f'settings-review-all-pages-{width}.png')
    h['click']('[data-settings-page="appearance"]')
    h['execute']("document.querySelector('.app-toast')?.remove();document.querySelector('[data-action=interface-scale-increase]').click();document.querySelector('[data-action=interface-scale-reset]').click();return true;")
    h['wait'](lambda:h['read']("return document.querySelector('.app-toast')?.textContent.includes('Interface scale set to 100%') && Math.abs(innerWidth-1200)<2;"),'rapid zoom then reset applies final choice')
    h['click']('[data-action="dismiss-toast"]')
    h['check']('rapid interface scale changes finish in request order and reset remains available while zoom is pending')
    h['click']('[data-action="interface-scale-increase"]')
    h['wait'](lambda:h['read']("return Math.abs(innerWidth-1000)<2;"),'native webview applies 120% zoom')
    h['wait'](lambda:h['shown']('.app-toast'),'scale notification displayed')
    assert h['read']("const t=document.querySelector('.app-toast').getBoundingClientRect(),f=document.querySelector('.settings-footer').getBoundingClientRect();return t.bottom<=f.top;"),'scale notification covers desktop Settings footer'
    h['request']('POST',f"/session/{h['session']}/window/rect",{'width':640,'height':480})
    assert h['read']("const f=document.querySelector('.settings-footer').getBoundingClientRect();return f.top>=0&&f.bottom<=innerHeight+1;"),'scaled settings footer clipped'
    assert h['read']("const t=document.querySelector('.app-toast')?.getBoundingClientRect(),f=document.querySelector('.settings-footer').getBoundingClientRect();return !t||t.bottom<=f.top;"),'scale notification covers narrow Settings footer'
    h['screenshot']('settings-review-scaled.png')
    # WebKitWebDriver's pointer coordinates are unreliable while the native
    # webview is zoomed. Exercise the real keyboard activation path instead.
    h['execute']("document.querySelector('[data-action=interface-scale-reset]').focus();return true;",idempotent=True)
    h['request']('POST',f"/session/{h['session']}/actions",{'actions':[{'type':'key','id':'zoom-reset','actions':[{'type':'keyDown','value':'\ue007'},{'type':'keyUp','value':'\ue007'}]}]})
    h['request']('POST',f"/session/{h['session']}/window/rect",{'width':1200,'height':780})
    h['wait'](lambda:h['read']("return Math.abs(innerWidth-1200)<2 && document.querySelector('[data-interface-scale-value]')?.textContent==='100%';"),'native webview resets to 100% zoom')
    if h['shown']('[data-action="dismiss-toast"]'):h['click']('[data-action="dismiss-toast"]')
    h['check']('all six Settings pages retain keyboard focus and visible navigation/footer at narrow, desktop and enlarged interface sizes')
