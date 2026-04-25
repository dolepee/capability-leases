import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = process.cwd();
const sources = Object.fromEntries(
  ["LeaseController.sol", "MockActionRouter.sol"].map((name) => {
    const filePath = path.join(root, "contracts", name);
    return [`contracts/${name}`, { content: fs.readFileSync(filePath, "utf8") }];
  }),
);

const input = {
  language: "Solidity",
  sources,
  settings: {
    evmVersion: "paris",
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object"],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = output.errors?.filter((entry) => entry.severity === "error") ?? [];
if (errors.length > 0) {
  for (const error of errors) console.error(error.formattedMessage);
  process.exit(1);
}

fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
for (const [sourceName, contracts] of Object.entries(output.contracts)) {
  for (const [contractName, artifact] of Object.entries(contracts)) {
    fs.writeFileSync(
      path.join(root, "artifacts", `${contractName}.json`),
      JSON.stringify(
        {
          sourceName,
          contractName,
          abi: artifact.abi,
          bytecode: `0x${artifact.evm.bytecode.object}`,
        },
        null,
        2,
      ),
    );
  }
}

console.log("Compiled", Object.values(output.contracts).flatMap((entry) => Object.keys(entry)).join(", "));
