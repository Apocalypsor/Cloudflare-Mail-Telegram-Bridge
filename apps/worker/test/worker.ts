export default {
  fetch(): Response {
    return new Response("test worker");
  },
} satisfies ExportedHandler;
