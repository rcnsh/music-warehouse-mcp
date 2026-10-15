# music-warehouse-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent (Claude
Code, Claude Desktop, Cursor and others) query the Spotify listening history
stored by a [music-warehouse](https://github.com/rcnsh/music-warehouse)
Worker. Ask "what was I into in spring 2022?", "when did I first play
Shelter?" or "how has my listening changed since I moved?" and the agent
answers from your own data, years of it, not Spotify's last 50 plays.

It runs locally over stdio and only reads: every tool calls the Worker's
`/api/*` routes with a read-only token. The Worker does the storage and
aggregation.

- [Requirements](#requirements)
- [Setting it up](#setting-it-up)
- [Configuration](#configuration)
- [Tools](#tools)
- [Development](#development)

## Requirements

- A deployed music-warehouse Worker with `READ_TOKEN` set, at a version that
  has `/api/search` and `/api/top-tracks` (October 2026 or later).
- Node.js 20 or later.

## Setting it up

### 1. Build

```bash
git clone https://github.com/rcnsh/music-warehouse-mcp && cd music-warehouse-mcp
npm install          # also builds dist/
```

### 2. Store the read token

On macOS, put the Worker's `READ_TOKEN` in the Keychain, under the service
`music-warehouse-mcp` and your Worker's host as the account. `security`
prompts for it, so it never lands in your shell history:

```bash
security add-generic-password -s music-warehouse-mcp -a music-api.example.com -w
```

Elsewhere, set `MUSIC_WAREHOUSE_TOKEN` in the MCP client's config instead (see
[Configuration](#configuration)). The environment wins over the Keychain.

### 3. Add it to your client

**Claude Code**, for every project:

```bash
claude mcp add --scope user music-warehouse \
  -e MUSIC_WAREHOUSE_URL=https://music-api.example.com \
  -- node "$PWD/dist/index.js"
```

Then `/mcp` in Claude Code shows it connected. If you run more than one Claude
Code config directory (`CLAUDE_CONFIG_DIR`), run the command once under each.

**Claude Desktop, Cursor and others** take the same thing as JSON:

```json
{
  "mcpServers": {
    "music-warehouse": {
      "command": "node",
      "args": ["/absolute/path/to/music-warehouse-mcp/dist/index.js"],
      "env": { "MUSIC_WAREHOUSE_URL": "https://music-api.example.com" }
    }
  }
}
```

A GUI app may not see your shell's `PATH`; if it can't start `node`, give its
absolute path (`which node`).

### 4. Check it

```bash
MUSIC_WAREHOUSE_URL=https://music-api.example.com npm run smoke
```

calls every tool once against your Worker and prints the start of each
answer. Or explore interactively with `npm run inspect`.

## Configuration

| Variable | Required | |
|---|---|---|
| `MUSIC_WAREHOUSE_URL` | yes | The Worker's origin. Must be `https`, except on loopback (`http://127.0.0.1:8787` for `wrangler dev`). |
| `MUSIC_WAREHOUSE_TOKEN` | no | The read token, if it isn't in the Keychain. Use `READ_TOKEN`, never `ADMIN_TOKEN`: nothing here needs more. |
| `MUSIC_WAREHOUSE_TZ` | no | IANA zone for local dates and times. Defaults to the system's. |

A missing token doesn't stop the server starting: each tool says how to
provide one, and the next call picks it up without a restart.

## Tools

Fourteen tools, all read-only. Dates are `YYYY-MM-DD` local days in the configured zone.

| Tool | Answers | Worker route |
|---|---|---|
| `search` | Artists and songs by name, with all-time plays. The way in to the history tools. | `/api/search` |
| `get_plays` | Individual plays, newest first, in a window. Pages with `next_before`. | `/api/plays` |
| `top_artists` | Plays per artist between two dates. | `/api/top-artists` |
| `top_tracks` | Plays per song between two dates, editions folded. | `/api/top-tracks` |
| `daily_play_counts` | Plays per day, or summed per week or month, with a total. | `/api/daily` |
| `artist_history` | One artist's plays, minutes, first and last play, months, top songs. | `/api/artist` |
| `track_history` | The same for one song, editions folded together. | `/api/track` |
| `on_this_day` | Top songs on this date in each earlier year. | `/api/on-this-day` |
| `get_stat` | `on-repeat`, `rhythm`, `top-over-time`, `eras` or `albums`. | `/api/stats/{name}` |
| `list_wrapped_ranges` | Which ranges `get_wrapped` can summarise. | `/api/wrapped/ranges` |
| `get_wrapped` | A Wrapped-style summary of a finished range. | `/api/wrapped` |
| `now_playing` | What's playing right now. | `/api/now-playing` |
| `recently_played_live` | Spotify's last plays, including ones not stored yet. | `/api/recently-played` |
| `spotify_top` | Spotify's own top tracks and artists. | `/api/top` |

The last three are live and need the Worker's Spotify grant; the rest read
stored rows and keep working when it lapses. When a tool fails, its message
says why and what to do: a lapsed grant names `npm run authorize`, a stat
still computing is waited out (up to 25 s) before giving up.

Responses are trimmed for an agent: no image URLs or Spotify API links, play
times shown in the local zone, Spotify objects cut to name, artists, album and
id.

### Why stdio, not a remote server

Running locally keeps the token on your machine and needs no change to the
Worker beyond the read routes. The trade-off is that claude.ai on the web and
mobile can't use it: their custom connectors need a remote server with OAuth.

## Development

```bash
npm run build        # tsc → dist/
npm test             # vitest: the client, formatting, and every tool over an in-memory MCP connection
npm run typecheck    # source and tests
```

Tests fake `fetch`, so they need no Worker. `npm run smoke` is the end-to-end
check against a real one.
