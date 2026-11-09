// TCP and RTU use the same dependency handler table. Restrict this correction
// to LinkLab vectors; do not alter unrelated servers or the installed package.
const handlers = require('modbus-serial/servers/servertcp_handler');
const vectors = new WeakSet();
const original = handlers.forceMultipleCoils;
handlers.forceMultipleCoils = (request, vector, unitId, callback) => {
  if (!vectors.has(vector)) return original(request, vector, unitId, callback);
  return handleCoilBatch(request, vector, unitId, callback);
};

function protectCoilBatchVector(vector) {
  vectors.add(vector);
  return vector;
}

function handleCoilBatch(request, vector, unitId, callback) {
  let completed = false;
  const done = (error) => {
    if (completed) return;
    completed = true;
    if (error) return callback(error);
    const response = Buffer.alloc(8);
    request.copy(response, 2, 2, 6);
    callback(null, response);
  };
  try {
    if (request.length < 9) return done({ modbusErrorCode: 3 });
    const address = request.readUInt16BE(2);
    const quantity = request.readUInt16BE(4);
    const byteCount = Math.ceil(quantity / 8);
    if (quantity < 1 || quantity > 1968) return done({ modbusErrorCode: 3 });
    if (address + quantity > 65536) return done({ modbusErrorCode: 2 });
    if (request[6] !== byteCount || request.length !== 9 + byteCount) {
      return done({ modbusErrorCode: 3 });
    }
    const values = Array.from({ length: quantity }, (_, index) => (
      Boolean(request[7 + Math.floor(index / 8)] & (1 << (index % 8)))
    ));
    // The vector validates the whole map range before its single splice.
    // Respond only after the batch hook has completed successfully.
    if (vector.setCoilArray.length === 4) {
      vector.setCoilArray(address, values, unitId, done);
    } else {
      const result = vector.setCoilArray(address, values, unitId);
      if (result && typeof result.then === 'function') result.then(() => done(), done);
      else done();
    }
  } catch (error) { done(error); }
}

module.exports = { protectCoilBatchVector, handleCoilBatch };
