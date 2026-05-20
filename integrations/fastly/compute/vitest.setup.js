import { createRequire } from 'module';
import Module from 'module';

const _resolveFilename = Module._resolveFilename.bind(Module);
Module._resolveFilename = (request, ...args) => {
  if (request === 'fastly:config-store') {
    return createRequire(import.meta.url).resolve('./__mocks__/fastly_config-store.js');
  }
  return _resolveFilename(request, ...args);
};
