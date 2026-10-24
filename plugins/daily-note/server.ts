// Server modules run in the OpenBuild process, with the same permissions. The `api` argument wraps
// a handler with OpenBuild's host, Origin and password checks; every route must live under
// /api/plugins/<id>/.
export default {
  routes: (api: (handler: (req: Request) => Response | Promise<Response>) => (req: Request) => Response | Promise<Response>) => ({
    "/api/plugins/daily-note/today": {
      GET: api(() => {
        const now = new Date();
        const day = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
        const prompts = [
          "Write down what I want to finish today, then turn it into a short checklist.",
          "Review yesterday's notes and suggest the three most useful next steps.",
          "Start a work log for today with the current state of this project.",
        ];
        return Response.json({
          day,
          text: `${day}: ${prompts[now.getDate() % prompts.length]}`,
        });
      }),
    },
  }),
};
