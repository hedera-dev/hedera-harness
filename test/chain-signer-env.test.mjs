import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const {
  buildAppEnv,
  buildAppServerEnv,
  buildDeployCommandEnv,
  buildDeployEnv,
} = await import(pathToFileURL(path.resolve("dist/validation/chainSigner.js")).href);

const signer = {
  accountId: "0.0.1234",
  evmAddress: "0x1111111111111111111111111111111111111111",
  privateKeyHex: "0xsecret",
  network: "testnet",
};

const chainValidation = {
  enabled: true,
  network: "testnet",
  operator: {
    accountIdEnv: "HEDERA_OPERATOR_ID",
    privateKeyEnv: "HEDERA_OPERATOR_KEY",
  },
  fundingHbar: 2,
  sweepBack: true,
  expose: {
    appEnv: {
      APP_OPERATOR_ID: "accountId",
      APP_OPERATOR_KEY: "privateKey",
    },
    envVars: ["DEPLOYER_PRIVATE_KEY"],
  },
};

test("buildAppEnv exposes only explicitly mapped signer fields", () => {
  assert.deepEqual(
    buildAppEnv(signer, {
      APP_OPERATOR_ID: "accountId",
      APP_OPERATOR_KEY: "privateKey",
      APP_OPERATOR_EVM_ADDRESS: "evmAddress",
    }),
    {
      APP_OPERATOR_ID: signer.accountId,
      APP_OPERATOR_KEY: signer.privateKeyHex,
      APP_OPERATOR_EVM_ADDRESS: signer.evmAddress,
    },
  );
  assert.deepEqual(buildAppEnv(signer), {});
});

test("buildDeployEnv keeps standard and legacy private-key variables", () => {
  assert.deepEqual(
    buildDeployEnv(signer, {
      envVars: ["DEPLOYER_PRIVATE_KEY"],
      appEnv: { DEPLOYER_ACCOUNT_ID: "accountId" },
    }),
    {
      HARNESS_SIGNER_ACCOUNT_ID: signer.accountId,
      HARNESS_SIGNER_EVM_ADDRESS: signer.evmAddress,
      HARNESS_SIGNER_PRIVATE_KEY: signer.privateKeyHex,
      DEPLOYER_PRIVATE_KEY: signer.privateKeyHex,
      DEPLOYER_ACCOUNT_ID: signer.accountId,
    },
  );
});

test("buildAppServerEnv blanks the funded operator and applies disposable mappings", () => {
  assert.deepEqual(buildAppServerEnv(signer, chainValidation), {
    HEDERA_OPERATOR_ID: "",
    HEDERA_OPERATOR_KEY: "",
    APP_OPERATOR_ID: signer.accountId,
    APP_OPERATOR_KEY: signer.privateKeyHex,
  });
});

test("buildAppServerEnv can remap operator names onto the disposable signer", () => {
  const remapped = {
    ...chainValidation,
    expose: {
      appEnv: {
        HEDERA_OPERATOR_ID: "accountId",
        HEDERA_OPERATOR_KEY: "privateKey",
      },
    },
  };
  assert.deepEqual(buildAppServerEnv(signer, remapped), {
    HEDERA_OPERATOR_ID: signer.accountId,
    HEDERA_OPERATOR_KEY: signer.privateKeyHex,
  });
});

test("buildDeployCommandEnv blanks the funded operator before disposable fields", () => {
  const env = buildDeployCommandEnv(signer, chainValidation);
  assert.equal(env.HEDERA_OPERATOR_ID, "");
  assert.equal(env.HEDERA_OPERATOR_KEY, "");
  assert.equal(env.HARNESS_SIGNER_PRIVATE_KEY, signer.privateKeyHex);
  assert.equal(env.DEPLOYER_PRIVATE_KEY, signer.privateKeyHex);
  assert.equal(env.APP_OPERATOR_ID, signer.accountId);
});
