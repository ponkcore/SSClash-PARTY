'use strict';
'require view';
'require fs';
'require view.ssclash.utils';

function yamlScalar(yaml, key) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(yaml || '').match(new RegExp(
        '^' + escaped + '\\s*:\\s*(["\\\']?)([^#\\r\\n]+?)\\1\\s*(?:#.*)?$', 'm'
    ));
    return match ? match[2].trim() : '';
}

function controllerParts(address) {
    const value = String(address || '').replace(/["']/g, '').trim();
    if (value.startsWith('[')) {
        const closing = value.indexOf(']');
        if (closing > 0 && value.charAt(closing + 1) === ':') {
            return { host: value.slice(1, closing), port: value.slice(closing + 2) };
        }
    }
    const separator = value.lastIndexOf(':');
    if (separator > 0 && value.indexOf(':') === separator) {
        return { host: value.slice(0, separator), port: value.slice(separator + 1) };
    }
    return { host: window.location.hostname, port: '9090' };
}

return view.extend({
    load: function() {
        return Promise.all([
            L.resolveDefault(fs.read('/opt/clash/config.yaml'), ''),
            view_ssclash_utils.getClashRunning()
        ]);
    },

    render: function(data) {
        const config = data[0];
        const running = data[1];
        if (!running) {
            return E('div', { 'class': 'cbi-section' }, [
                E('h2', _('SSClash PARTY Dashboard')),
                E('p', {}, _('Mihomo is not running. Start it from Configuration before opening the dashboard.')),
                E('a', {
                    'class': 'btn',
                    'href': L.url('admin/services/ssclash/config')
                }, _('Open Configuration'))
            ]);
        }

        const secret = yamlScalar(config, 'secret');
        const controller = controllerParts(yamlScalar(config, 'external-controller'));
        if (!secret || !controller.host || !/^\d+$/.test(controller.port)) {
            return E('div', { 'class': 'cbi-section' }, [
                E('h2', _('SSClash PARTY Dashboard')),
                E('p', {}, _('The protected controller settings could not be read. Re-apply the active managed profile.'))
            ]);
        }

        const parameters = new URLSearchParams();
        parameters.set('secret', secret);
        parameters.set('hostname', controller.host);
        parameters.set('port', controller.port);
        const target = '/party-dashboard/#/setup?' + parameters.toString();

        window.setTimeout(function() {
            window.location.replace(target);
        }, 0);

        return E('div', { 'class': 'cbi-section' }, [
            E('h2', _('Opening SSClash PARTY Dashboard…')),
            E('p', {}, _('LuCI authentication succeeded. The controller token is being passed in the URL fragment and is not sent to uHTTPd.')),
            E('a', { 'class': 'btn', 'href': target }, _('Continue'))
        ]);
    },

    handleSave: null,
    handleSaveApply: null,
    handleReset: null
});
