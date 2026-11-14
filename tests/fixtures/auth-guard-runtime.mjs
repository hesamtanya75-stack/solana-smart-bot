import { AuthGuard } from "../../auth-guard.mjs";

export { AuthGuard };

export default {
  async fetch() {
    return new Response("AuthGuard runtime test worker");
  }
};
