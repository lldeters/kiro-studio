# Kiro Studio – Plan

Inoffizielle VS-Code-Extension, die die lokal installierte Kiro CLI über das Agent Client Protocol (ACP)
bedient. Nicht mit AWS oder Kiro verbunden.

**Status: Phase 0 abgeschlossen, wartet auf deine Freigabe.** Dieses Dokument braucht von dir vor allem
Antworten auf Abschnitt 7, und für die erste Frage ein Ergebnis von deinem Rechner.

Verwandte Dokumente: [ARCHITECTURE.md](ARCHITECTURE.md) (wie die Teile zusammenhängen),
[protocol-notes.md](protocol-notes.md) (Protokollfakten mit Belegstufe je Aussage).

## 1. Was Phase 0 geliefert hat und was nicht

| Geliefert | Zustand |
| --- | --- |
| `scripts/probe-acp.ts` (`npm run probe`) | Lauffähig und typgeprüft. Getestet gegen einen Replay-Agenten, der echte aufgezeichnete Kiro-Nachrichten abspielt: Handshake, Session, Freigaben, Ablehnung, Absturz, kaputte Zeile, CLI nicht gefunden. **Nicht gegen eine echte `kiro-cli` gelaufen.** |
| `docs/protocol-notes.md` | Jede Aussage trägt eine Belegstufe (Doku laut deinem Prompt / Aufzeichnung / SDK-Quelltext / offen). |
| `docs/ARCHITECTURE.md` | Zieldesign, plus was bereits belegt ist. |
| `docs/PLAN.md` | Dieses Dokument. |
| Repo-Gerüst | Nur das, was die Probe braucht (`package.json`, `.gitignore`, `scripts/`). Kein Feature-Code. |

**Warum nicht gegen die echte CLI:** In diesem Cloud-Container ist `kiro-cli` nicht installiert und ein Login
mit deinem Konto ist dort nicht sinnvoll. Außerdem blockiert die Netzwerkrichtlinie `kiro.dev`, `cli.kiro.dev`
und `agentclientprotocol.com`; die Kiro-Doku konnte ich nicht direkt lesen, nur Suchausschnitte davon.

**Woher die Protokollfakten stammen:**

1. Dein Prompt (zitiert die Kiro-Doku, Stand Oktober 2026).
2. 15 Aufzeichnungen echter Sitzungen mit `kiro-cli` **2.32.0** (V3-Engine) aus dem Kiro-Provider von
   [T3 Code, PR 14693](https://github.com/pingdotgg/t3code/pull/14693) (MIT-Lizenz). Drittquelle, Oktober 2026,
   Identity-Center-Login. Ich habe sie gegen die Schemas des SDK geprüft: alle 671 geprüften eingehenden Nachrichten sind gültig (Werkzeug: `npm run validate-wire`).
3. Quelltext von `@agentclientprotocol/sdk` 2.0.1.

Wo deine CLI abweicht, gilt deine CLI. Alles, was nur die Probe klären kann, steht als `[P]` in den Notizen.

## 2. Die wichtigsten Erkenntnisse

Details und Belege in `protocol-notes.md`, Abschnitt 16.

1. **`protocolVersion` ist in den Aufzeichnungen 2**, das SDK spricht standardmäßig v1 und nennt v2 experimentell.
   Die Antwort von Kiro sieht auf der Leitung nach v1 aus. Was Kiro auf `protocolVersion: 1` antwortet, weiß ich
   nicht. Das ist die erste Frage an die Probe (Risiko R1).
2. **Das SDK verwirft Nachrichten still.** Sein interner Router prüft jede `session/update` streng, bevor mein Code
   sie sieht; schlägt die Prüfung fehl, geht die Nachricht verloren. Deshalb leitet die Extension `session/update`
   und alle `_*`-Notifications auf Stream-Ebene in einen eigenen, toleranten Dispatcher um. Die Probe macht das
   bereits so. Die SDK-Hilfe `buildSession()` scheidet aus, weil Kiro Updates **vor** der `session/new`-Antwort sendet.
3. **Supervised/Autopilot ist eine Config-Option** (`autopilot` = `on`/`off`), kein eigener Modus. Im Supervised-Modus
   kommt am Turn-Ende eine zweite Freigabe „Review changes“ (`turn_approval`).
4. **Autopilot heißt nicht „keine Rückfragen“.** Auch mit `autopilot: on` fragt Kiro bei Schreibzugriffen
   (`askType: "implicit"`). Das berührt deine Vorgabe, Kiros Regeln nie auszuhebeln (Frage 2).
5. **Kiro schreibt Dateien vermutlich selbst.** Der Tool-Call enthält den fertigen Inhalt; die Aufzeichnungen
   schalten `fs`/`terminal` aber ab, belegen also nichts darüber. Wenn Kiro `fs/write_text_file` nicht nutzt, ist
   „Schreibzugriffe zurückhalten und Hunks einzeln annehmen“ vor dem Schreiben nicht möglich; es bleibt Allow/Deny
   mit Diff-Vorschau vorher und Prüfung/Revert nachher. Die Probe meldet, ob `fs/*` genutzt wird.
6. **`model` und `effortLevel` erscheinen spät** und nicht in der `session/new`- oder `session/load`-Antwort;
   Schreibreihenfolge und Wartezeiten sind zu beachten (Notizen Abschnitt 3). Nach Möglichkeit klärt die Probe, ob
   `model` auch ungefragt kommt.
7. **Abbrechen kann wirkungslos sein**, wenn es zu früh kommt. `session/cancel` ist eine Notification und wird erst
   nach `turn_start` gesendet.
8. **Die Liste der `_kiro/*`-Methoden in 2.32.0 weicht von deinem Prompt ab:** keine `mcp/status`, `hooks/list`,
   `account/getUsage`, `session/rename`, `_session/steer`; dafür `memory/*`, `session/export`, `session/history`,
   `config/template`, `sourceProviders/*`. MCP- und Hook-Status kommen vermutlich als Broadcast-Notifications.
   Die UI darf deshalb nicht an Request-Methoden hängen, sondern an „was die installierte CLI anbietet“.
9. **Hooks brauchen ein Opt-in des Clients** (`clientCapabilities._meta.kiro.hooks`), sonst lädt V3 keine Hooks.
10. **Es gibt kein `/spec` in `available_commands_update`**; Spec-Workflows sind Modi (`spec`, `quick-spec`,
    `bug-fix`). Der Assistent „Neue Spec“ setzt also zuerst den Modus.

## 3. Architektur in Kürze

Siehe [ARCHITECTURE.md](ARCHITECTURE.md). Kernpunkte:

- Ein `kiro-cli acp`-Prozess pro Fenster, mehrere Sessions, Start bei Bedarf, sauberes Beenden.
- Schichten: `kiro/cli` → `acp/connection` (Prozess, Rohlog, Umleitung) → `acp/dispatcher` (tolerante Typen) →
  `acp/sessions` (Store, Turn-Zustandsautomat, Freigabe-Queue; ohne VS-Code-Import, daher testbar) → Views/Webviews.
- Dateibasierte Bereiche (Specs, Steering, Hooks, MCP, Agents) über Watcher und Parser; JSON formatierungserhaltend.
- Checkpoints in einem Schatten-Git-Repo im Extension-Speicher; das Repo des Nutzers bleibt unberührt.

## 4. Technikentscheidungen

| Thema | Entscheidung | Begründung |
| --- | --- | --- |
| `engines.vscode` | **`^1.93.0`** | Die stabile Terminal-Shell-Integration (`onDidEndTerminalShellExecution`, `TerminalShellExecution`) gibt es erst ab 1.93; ich habe es an den Typen von `@types/vscode` 1.92 und 1.93 geprüft. Sie wird für `#terminal` gebraucht. `vscode.l10n` gäbe es schon ab 1.73, WebviewView und TreeView sind älter. VS Code 1.93 bringt Node 20 mit, passend zu „Node 20+“. Ohne `#terminal` wäre `^1.73.0` die untere Grenze (wegen `l10n`); die übrigen geplanten APIs habe ich nicht einzeln geprüft. |
| SDK | `@agentclientprotocol/sdk` **2.0.1**, exakt gepinnt | Fluent-API (`client()`, `onRequest`, `connectWith`); `ClientSideConnection` gibt es nicht mehr. |
| SDK-Einstiegspunkt | `/unstable` | Nur dort gibt es `session/fork` und `session/delete`. Die Entscheidung hängt von R1 ab (v1 oder v2). |
| Eigene Schicht über dem SDK | Umleitung + toleranter Dispatcher | siehe Erkenntnis 2 |
| Extension-Bundle | esbuild, CJS, SDK mit eingebündelt | Die Extension liefert kein `node_modules` aus. Wichtig: Das Wurzel-`package.json` bekommt **kein** `"type": "module"`, sonst lädt VS Code das CJS-Bundle als ESM. Skripte unter `scripts/` sind ESM über ein eigenes `scripts/package.json`. |
| Webview | React, Vite, `react-markdown` + `remark-gfm`, Shiki (JS-Regex-Engine), Mermaid lazy, `react-virtuoso`, Zustand | wie im Prompt; `@vscode/webview-ui-toolkit` bleibt tabu. |
| Tests | Vitest, `@vscode/test-cli`, Fake-Agent über In-Memory-Streams | wie im Prompt. Aufzeichnungen Dritter nur lokal als Gegenprobe, bis die Lizenzfrage (MIT, Namensnennung) sauber gelöst ist; Fixtures kommen aus Probe-Ausgaben oder sind handgeschrieben. |
| Protokoll-Log | Output-Channel „Kiro Studio: Protocol“, Schwärzung (Tokens, E-Mail, Home-Pfad) | Die Schwärzfunktion der Probe wandert nach `src/util/redact.ts`. |
| Lizenz | vorerst `UNLICENSED` | Frage 6 |

## 5. Phasenplan

Nach jeder Phase: build, lint, test grün; kurze Zusammenfassung an dich; Commit (Conventional Commits);
`ARCHITECTURE.md` aktualisiert.

### Phase 1 – Fundament

- Gerüst: `package.json` mit `contributes`, esbuild, strikte `tsconfig`, ESLint, Prettier, Vitest, `@vscode/test-cli`,
  `vsce`, `.vscodeignore`, `package.nls*.json` (Englisch + Deutsch), GitHub-Actions-Matrix (Windows, macOS, Linux).
- `kiro/cli.ts`: Suche (Einstellung `kiroStudio.cliPath` → PATH → `where`/`which` → typische Orte), `--version`,
  `whoami` (nur erste Zeile als JSON lesen), `doctor`, Login im VS-Code-Terminal; Zustände *fehlt / zu alt / nicht
  angemeldet / bereit*.
- `acp/connection.ts`: Prozess, Rohlog, Umleitung, Handler vor `initialize` bzw. `session/new`, Neustart mit
  Backoff, Wiederaufnahme per `session/load` (MCP-Server erneut senden), sauberes Beenden.
- `acp/capabilities.ts`, `acp/sessions.ts` (Store, Turn-Automat, Freigabe-Queue), Handler für Freigaben, `fs`
  (über die VS-Code-API, ungespeicherte Editor-Inhalte beachten), `terminal`, `_kiro/openExternalUrl`.
  `fs`/`terminal` werden nur angeboten, wenn die Probe zeigt, dass Kiro sie nutzt, sonst nicht (Frage entfällt).
- Statusleiste mit Quick-Menü, Onboarding (Willkommensansicht + Walkthrough), Workspace-Trust-Sperre.
- Vorläufige Freigabe-UI per QuickPick und ein Debug-Befehl „Prompt senden“, damit die Verbindung ohne Chat testbar ist.
- **Abnahme:** Tests grün; mit deiner CLI: verbinden, Session anlegen, Prompt senden, Freigabe beantworten,
  Prozess abschießen und wiederaufnehmen. Windows-, macOS- und Linux-Pfade in der CI-Matrix.
- **Voraussetzung:** Probe-Ergebnis (Frage 1).

### Phase 2 – Chat

- Chat-WebviewView im eigenen Activity-Bar-Container (in die sekundäre Seitenleiste verschiebbar), optional Editor-Tab,
  Sessions als Tabs; Streaming mit Markdown, Code-Highlighting, Mermaid; „Thinking“ einklappbar, falls Kiro es sendet.
- Tool-Karten (Icon je `kind`, Status, klickbare Dateien, Terminal-Ausgabe, `+x −y`, „Diff öffnen“ per `vscode.diff`
  über einen virtuellen Dokument-Provider; `file://`-Pfade normalisieren; `oldText: ""` als neue Datei behandeln).
  Der Status eines Tool-Calls ist nicht monoton; „wartet auf Freigabe“ kommt aus der Freigabe-Queue, nicht aus `status`.
- Inline-Freigaben mit genau den angebotenen Optionen (nach `kind` gewählt), einschließlich der „Review changes“-Freigabe;
  `allow_always` mit Hinweis, dass Kiro daraus eine dauerhafte Regel macht.
- Supervised/Autopilot-Umschalter (Config-Option `autopilot`), Verhalten laut Frage 2.
- Eingabe: Enter, Shift+Enter, Esc = Abbrechen (erst nach `turn_start`, begrenzte Wartezeit). Steer: nur wenn `_session/steer`
  angekündigt ist, sonst Abbrechen + neuer Prompt als ausdrücklich so benannte Ersatzlösung.
- `/`-Autovervollständigung (angekündigte Commands + gemappte Aktionen), `#`-Kontext (`#file`, `#folder`, `#current`,
  `#problems`, `#git diff`, `#terminal`, `#steering`, `#spec`, `#url`) je nach `promptCapabilities` (`image`,
  `embeddedContext` sind angekündigt); Bilder per Einfügen/Drop.
- Toolbar: Agent (`mode`), Modell, Effort (nur wenn angeboten), Kontext-Füllstand, „Kontext komprimieren“ (nur wenn
  `_kiro/session/compact` angekündigt). Sub-Agent-Aktivität über `agentSubtaskId` gruppiert.
- Checkpoints (Schatten-Repo), „View all changes“, Revert je Datei oder komplett, „Rewind to here“ (`session/fork`, sobald die
  Parameter bekannt sind), Export als Markdown.
- **Abnahme:** flüssiges Streaming, sofort reagierende Freigaben, nativer Diff, Revert stellt Dateien zuverlässig wieder her.

### Phase 3 – Kiro-Panel

Sessions (`session/list` mit Scopes workspace/user und Quellen local/remote, öffnen mit Replay, umbenennen nur wenn
angekündigt, forken, suchen), Specs, Steering, Hooks, MCP, Agents.
MCP- und Hook-Zustand aus dem, was die CLI anbietet (Request-Methode oder Broadcast); Hooks nach Frage 5.

### Phase 4 – Specs

Assistent „Neue Spec“ (zuerst Modus setzen, dann strukturierter Prompt), Spec-Ansicht mit Tabs, Mermaid und
Fortschritt, CodeLens und Task-Ausführung, Review-Modus. Das `tasks.md`-Format wird an einer **echten** Kiro-Spec
ermittelt (Frage 4), nicht aus der Doku geraten.

### Phase 5 – Feinschliff

Themes (hell, dunkel, High Contrast), Barrierefreiheit, Performance bei langen Chats, Lokalisierung, README mit Screenshots, `.vsix`.

## 6. Risiken

| # | Risiko | Wirkung | Gegenmaßnahme |
| --- | --- | --- | --- |
| R1 | Kiro verlangt `protocolVersion: 2`, das SDK-Standard ist v1 (v2 experimentell). | Handshake scheitert, oder Verhalten weicht ab. | Probe testet beide Werte. Fällt es auf v2, entscheiden wir über `experimental/v2` oder eine dünne eigene JSON-RPC-Schicht. Die Umleitung und der Dispatcher sind davon kaum betroffen. |
| R2 | Das SDK verwirft eine unbekannte `session/update` still. | Verlorene Updates, Zustand falsch. | Umleitung auf Stream-Ebene (eingebaut in die Probe, in Phase 1 als Test). |
| R3 | `_kiro/*`-Angebot unterscheidet sich je CLI-Version. | Funktionen fehlen oder brechen. | Alles über `extensionMethods` und beobachtete Broadcasts freischalten, nie über die Version; UI mit Leerzustand je Funktion. |
| R4 | Kiro nutzt `fs/*` nicht und schreibt selbst. | Kein Zurückhalten und Hunk-Review vor dem Schreiben. | Allow/Deny mit Diff-Vorschau vorher, Schatten-Repo nachher (Frage 3). |
| R5 | Protokollfakten stammen teils aus Drittquellen und einer älteren CLI. | Falsche Annahmen. | Belegstufen in den Notizen; Probe auf deiner CLI; Integrationstests gegen die echte CLI als manueller Schritt. |
| R6 | Spät und ungeordnet eintreffende Config-Updates, wirkungslose frühe Writes. | Falscher Modell-/Effort-Stand. | Schreibreihenfolge und Verwerfen veralteter Antworten im Session-Store, mit Tests. |
| R7 | Frühes `session/cancel` wird ignoriert. | Abbrechen wirkt nicht. | Erst nach `turn_start` senden, begrenzte Wartezeit, UI zeigt „bricht ab…“ bis zur Antwort. |
| R8 | Hook-Opt-in ändert das Verhalten (globale Hooks laufen). | Überraschende Befehle. | Opt-in nur bewusst, nie im Probe-Standardlauf (Frage 5). |
| R9 | Entwicklung kostet Credits. | Kosten. | Fake-Agent für Tests; Probe mit `--no-prompt` ist kostenlos. |
| R10 | Windows: Prozessstart, Pfade (`file://`, Laufwerksbuchstaben), `.cmd`-Wrapper, CRLF. | Fehler nur auf Windows. | CI-Matrix früh, Pfadnormalisierung zentral, `kiro-cli.exe` bevorzugen. Ein echter Windows-Installationspfad fehlt mir (Frage 7). |
| R11 | Sehr lange Chats, große `rawOutput`/`preview`-Nutzlasten. | Webview träge, Nachrichten über dem SDK-Größenlimit. | Virtualisierung, gekürzte Darstellung, Nachrichtenlimit konfigurieren und messen. |
| R12 | Namens- oder Markenprobleme („Kiro“). | Beanstandung beim Veröffentlichen. | Eigener Name und Icon, deutlicher Hinweis „inoffiziell“, keine Kiro-Assets. |
| R13 | ACP-v2-SDK ändert sich ohne Vorwarnung. | Wartungsaufwand. | SDK exakt pinnen, ACP-Schicht klein und hinter eigenen Typen halten. |

## 7. Offene Fragen an dich

Die ersten beiden sind für den Start von Phase 1 bzw. Phase 2 wichtig. Der Rest ist nicht eilig.

1. **Probe auf deinem Rechner laufen lassen (blockiert Phase 1).** Anleitung in Abschnitt 8. Ein Lauf kostet einen
   Bruchteil eines Credits (in den Aufzeichnungen rund 0,02 Credits für einen Einzeiler; dein Standardmodell kann mehr
   verbrauchen); `--no-prompt` ist kostenlos. Schickst du mir `summary.json` und `wire.ndjson` aus `probe-logs/<Lauf>/`
   (vorher durchsehen, die Schwärzung ist nur ein Hilfsmittel), kann ich die Notizen schließen. Alternativ schaltest du
   in den Umgebungseinstellungen `kiro.dev` und `agentclientprotocol.com` frei, dann lese ich die Doku selbst; die Probe
   braucht trotzdem deine Maschine.
2. **Freigaben im Autopilot-Modus (Trade-off, wirkt auf Phase 2).** Kiro fragt bei Schreibzugriffen auch im Autopilot
   (`askType: "implicit"`). Optionen:
   - **A (Empfehlung):** Immer anzeigen, was Kiro fragt. Ein optionaler Schalter „Implizite Rückfragen einmalig erlauben“
     beantwortet nur Anfragen mit `askType: implicit` automatisch mit `allow_once` und nie `allow_always`; ausdrückliche
     Regeln von Kiro (vermutlich `explicit`, das prüft die Probe) werden immer gezeigt.
   - **B:** Im Autopilot alles automatisch einmalig erlauben (so macht es T3 Code). Bequem, hebelt aber Kiros ask-Regeln aus,
     was du ausgeschlossen hast.
   - **C:** Nie automatisch antworten. Sicher, aber Autopilot fühlt sich nicht wie in der Kiro IDE an.
3. **Checkpoint-Grundlage für Revert und „View all changes“.** Dein Prompt: Schatten-Git-Repo, das auch greift, wenn Kiro
   selbst schreibt. Kiro hat eigene Checkpoints (`checkpoints: true`, `kiro-snapshot-v2://`). Empfehlung: dein Schatten-Repo
   wie beschrieben als verlässliche Basis; Kiros Checkpoints später prüfen und nur als Zusatz nutzen, wenn sie ein Client
   zuverlässig lesen und zurückspielen kann. Einverstanden?
4. **Beispiel-Spec (Phase-0-Punkt 4).** Auf dieser Maschine gibt es keine `.kiro/specs/…`. Entweder legst du eine echte Spec
   (gern entschärft) unter `fixtures/specs/` ab, was nichts kostet und am verlässlichsten ist, oder ich lasse Kiro in Phase 4 eine
   kleine Test-Spec erzeugen (kostet Credits). Empfehlung: du lieferst eine. Nötig erst in Phase 4.
5. **Hooks-Opt-in.** Ohne `clientCapabilities._meta.kiro.hooks` lädt V3 keine Hooks; mit Opt-in muss der Client `_kiro/hooks/*`
   beantworten und globale Hooks laufen. Soll Kiro Studio Hooks aktivieren (Empfehlung: ja, als Einstellung, Standard an, sobald die Probe
   mit `--hooks` zeigt, was dabei vom Client verlangt wird)? Entscheidung in Phase 3.
6. **Publisher, Extension-ID, Lizenz.** `package.json` braucht einen `publisher`; die Lizenz steht auf `UNLICENSED`. Soll es
   MIT werden? Soll das Repo öffentlich sein?
7. **Windows-Installationspfad der CLI.** Ich kenne nur `~/.local/bin` (laut Drittquelle) und PATH. Zeigt `where kiro-cli` auf
   deinem Windows-11-Rechner einen Pfad, nimm ich ihn in die Kandidatenliste auf.

## 8. Probe ausführen

Voraussetzungen: Node 20+, installierte und angemeldete Kiro CLI (`kiro-cli whoami`).

```bash
git fetch origin claude/dreamy-curie-tne5sj && git checkout claude/dreamy-curie-tne5sj
npm ci
npm run probe                      # voller Lauf, ein Mini-Prompt, Supervised
```

Weitere Läufe (jeweils eigener Ordner unter `probe-logs/`):

```bash
npm run probe -- --no-prompt                  # nur Handshake und Session, kostenlos
npm run probe -- --autopilot on               # was wird im Autopilot noch gefragt?
npm run probe -- --protocol-version 2         # gegen den Standardwert 1 vergleichen
npm run probe -- --terminal                   # führt von Kiro angeforderte Befehle im Temp-Ordner aus
npm run probe -- --hooks --no-prompt          # Hook-Verkehr sehen (kann globale Hooks starten)
npm run probe -- --cli "C:\\Pfad\\kiro-cli.exe"   # Windows, falls nicht im PATH
```

Die Probe arbeitet in einem frischen Temp-Ordner und erlaubt Freigaben nur einmalig und nur, wenn alle genannten Pfade
darin liegen (`--approve none` lehnt alles ab). Ergebnis: `summary.json` (Zusammenfassung), `wire.ndjson` (jede Zeile auf
der Leitung, vor dem SDK-Parsing), `stderr.log`. Der Ordner `probe-logs/` ist von Git ausgeschlossen.
