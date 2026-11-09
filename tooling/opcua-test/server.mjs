import { createRequire } from 'node:module';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const ua = require('node-opcua');

// This fixture binds only loopback. Its accepting certificate manager is test-only.
export async function createOpcuaTestServer({ port = 0, directory } = {}) {
  const temporary = !directory;
  directory ??= await mkdtemp(join(tmpdir(), 'linklab-opcua-server-'));
  const manager = new ua.OPCUACertificateManager({ rootFolder: join(directory, 'pki'), automaticallyAcceptUnknownCertificate: true });
  await manager.initialize();
  const certificateFile = join(directory, 'server.pem');
  let certificateExists = false;
  try { await access(certificateFile); certificateExists = true; } catch { /* First isolated start. */ }
  if (!certificateExists) await manager.createSelfSignedCertificate({ applicationUri: 'urn:ineedfull:linklab:test-server',
    subject: '/CN=LinkLab Local Test Server', dns: ['localhost'], ip: ['127.0.0.1'],
    validity: 365, outputFile: certificateFile });
  const server = new ua.OPCUAServer({ port, host: '127.0.0.1', hostname: '127.0.0.1', alternateHostname: ['localhost'],
    resourcePath: '/LinkLab', serverCertificateManager: manager, certificateFile,
    serverInfo: { applicationUri: 'urn:ineedfull:linklab:test-server', productUri: 'urn:ineedfull:linklab:test-server', applicationName: { text: 'LinkLab Local Test Server' } },
    securityPolicies: [ua.SecurityPolicy.None, ua.SecurityPolicy.Basic256Sha256],
    securityModes: [ua.MessageSecurityMode.None, ua.MessageSecurityMode.Sign, ua.MessageSecurityMode.SignAndEncrypt],
    allowAnonymous: true, userManager: { isValidUser: (name, password) => name === 'tester' && password === 'test-only-password' },
    registerServerMethod: ua.RegisterServerMethod.HIDDEN });
  await server.initialize();
  const namespace = server.engine.addressSpace.registerNamespace('urn:ineedfull:linklab:test');
  const folder = namespace.addObject({ organizedBy: server.engine.addressSpace.rootFolder.objects, browseName: 'LinkLab', nodeId: `ns=${namespace.index};s=LinkLab` });
  const definitions = [
    ['Temperature', 'Double', 23.5], ['Counter', 'Int32', 10], ['Enabled', 'Boolean', true],
    ['Text', 'String', 'LinkLab'], ['Wide', 'Int64', [0x7fffffff, 0xffffffff]],
    ['UnsignedWide', 'UInt64', [0xffffffff, 0xffffffff]], ['Bytes', 'ByteString', Buffer.from([0, 0xff, 0x41])],
    ['Array', 'Int16', [1, -2, 3]], ['ReadOnly', 'Double', 7],
  ];
  const nodes = {};
  for (const [name, type, initial] of definitions) {
    let value = initial;
    const array = name === 'Array';
    nodes[name] = `ns=${namespace.index};s=${name}`;
    namespace.addVariable({ componentOf: folder, nodeId: nodes[name], browseName: name, dataType: type,
      minimumSamplingInterval: 50, valueRank: array ? 1 : -1, arrayDimensions: array ? [0] : null,
      accessLevel: name === 'ReadOnly' ? 'CurrentRead' : 'CurrentRead | CurrentWrite',
      value: { get: () => new ua.Variant({ dataType: ua.DataType[type], arrayType: array ? ua.VariantArrayType.Array : ua.VariantArrayType.Scalar, value }),
        ...(name === 'ReadOnly' ? {} : { set: variant => { value = variant.value; return ua.StatusCodes.Good; } }) } });
  }
  const dynamic = namespace.addVariable({ componentOf: folder, nodeId: `ns=${namespace.index};s=Changing`, browseName: 'Changing', dataType: 'Double', minimumSamplingInterval: 50,
    value: new ua.Variant({ dataType: ua.DataType.Double, value: 0 }) });
  nodes.Changing = dynamic.nodeId.toString(); nodes.Folder = folder.nodeId.toString();
  await server.start();
  const endpointUrl = server.getEndpointUrl();
  let tick = 0; const timer = setInterval(() => dynamic.setValueFromSource({ dataType: ua.DataType.Double, value: ++tick }), 100);
  return { server, directory, endpointUrl, nodes,
    async close() { clearInterval(timer); await server.shutdown(0); await manager.dispose(); if (temporary) await rm(directory, { recursive: true, force: true }); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await createOpcuaTestServer({ port: Number(process.env.OPCUA_TEST_PORT ?? 48409) });
  console.log(JSON.stringify({ endpointUrl: fixture.endpointUrl, nodes: fixture.nodes }));
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (closing) return; closing = true; await fixture.close(); process.exit(0);
  });
}
