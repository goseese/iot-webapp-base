// Unmanaged broker: gateways share one fixed credential, so provisioning hands out the GUID
// only and no per device user exists. Swap for dynsec.js when a managed broker is available.
module.exports =
{
    name: "static",
    managesUsers: false,
    // (guid, acls) - acls from mqtt/topics.deviceAcls; the static driver has nowhere to apply them.
    async createDeviceUser() { return { password: null }; },
    async removeDeviceUser() {},
    async createAccountUser() { return { password: null }; },
    async removeAccountUser() {}
};
