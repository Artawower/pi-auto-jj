export default {
  test: {
    include: ["**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@mariozechner/pi-coding-agent":
        new URL("./test-stubs/pi-coding-agent.ts", import.meta.url).pathname,
    },
  },
};
