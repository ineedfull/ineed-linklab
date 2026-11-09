export const plan = (protocol = 'modbus') => ({
  id: 'plan-1',
  name: 'Read only',
  protocol,
  checks: [
    {
      id: 'check-1',
      name: 'Value',
      query:
        protocol === 'modbus'
          ? {
              unitId: 1,
              functionCode: 3,
              address: 0,
              quantity: 1,
              timeoutMs: 1000,
            }
          : { nodeId: 'ns=1;s=value' },
      assertion: { kind: 'equals', expected: protocol === 'modbus' ? [7] : 7 },
    },
  ],
});
