"use strict";

const ConfigStore = function () {
  return { get: () => "test-secret" };
};

module.exports = { ConfigStore };
