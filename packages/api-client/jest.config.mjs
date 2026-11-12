/** @type {import('jest').Config} */
export default {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: "src",
  testRegex: ".*\\.unit\\.spec\\.ts$",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^#fetcher-env$": "<rootDir>/fetcher/client.ts",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: {
          module: "nodenext",
          moduleResolution: "nodenext",
        },
      },
    ],
  },
  testEnvironment: "node",
};
