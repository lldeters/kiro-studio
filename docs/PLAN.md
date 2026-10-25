# Kiro Studio – Plan

Inoffizielle VS-Code-Extension, die die lokal installierte Kiro CLI über das Agent Client Protocol (ACP)
bedient. Nicht mit AWS oder Kiro verbunden.

**Status: Phase 0 bis 3 sind umgesetzt (Phase 1 siehe Abschnitt 9, Phase 2 Abschnitt 10, Phase 3 Abschnitt 11). Alles ist gebaut,
getestet und per CI geprüft (Linux, macOS, Windows; VS Code 1.93.0 und stable), aber noch nicht gegen deine echte CLI
durchgespielt. Abnahme und ein paar kurze Probe-Läufe stehen aus (Abschnitte 8 bis 11).**

Verwandte Dokumente: [ARCHITECTURE.md](ARCHITECTURE.md) (wie die Teile zusammenhängen),
[protocol-notes.md](protocol-notes.md) (Protokollfakten mit Belegstufe je Aussage).

## 1. Was Phase 0 geliefert hat und was nicht

| Geliefert | Zustand |
| --- | --- |
| `scripts/probe-acp.ts` (`npm run probe`) | Lauffähig und typgeprüft. Getestet gegen einen Replay-Agenten mit echten aufgezeichneten Kiro-Nachrichten (Handshake, Session, Freigaben, Ablehnung, Absturz, kaputte Zeile, CLI nicht gefunden, CLI beendet nicht bei geschlossenem stdin) und **einmal gegen deine echte `kiro-cli` 2.33.1 unter Windows 11**. |
| `scripts/validate-wire.ts`, `scripts/redact.ts` | Prüft ein Probe-Log gegen die Schemas des SDK; Schwärzung von Tokens, E-Mail und Home-Pfad in allen Schreibweisen, die Kiro verwendet. |
| `docs/protocol-notes.md` | Jede Aussage trägt eine Belegstufe: Doku laut deinem Prompt, Aufzeichnung Dritter, SDK-Quelltext, **verifiziert auf deiner Maschine `[V]`**, oder offen. |
| `docs/ARCHITECTURE.md` | Zieldesign, plus was bereits belegt ist. |
| `docs/PLAN.md` | Dieses Dokument. |
| Repo-Gerüst | Nur das, was die Probe braucht (`package.json`, `.gitignore`, `scripts/`). Kein Feature-Code. |

**Wo etwas lief:** `kiro-cli` ist im Cloud-Container nicht installiert und ein Login mit deinem Konto ist dort nicht
sinnvoll, deshalb lief die echte Probe bei dir. Außerdem blockiert die Netzwerkrichtlinie des Containers `kiro.dev`,
`cli.kiro.dev` und `agentclientprotocol.com`; die Kiro-Doku konnte ich nicht direkt lesen, nur Suchausschnitte davon.

**Woher die Protokollfakten stammen:**

1. **Dein Probe-Lauf 1** (`kiro-cli` 2.33.1, Kiro Agent Server 0.66.58, Windows 11, Google-Login, 2026-10-23): Tag `[V]`.
   Alle 45 eingehenden Nachrichten bestehen die SDK-Schemas.
2. Dein Prompt (zitiert die Kiro-Doku, Stand Oktober 2026).
3. 15 Aufzeichnungen echter Sitzungen mit `kiro-cli` **2.32.0** (V3-Engine) aus dem Kiro-Provider von
   [T3 Code, PR 14693](https://github.com/pingdotgg/t3code/pull/14693) (MIT-Lizenz). Drittquelle, Oktober 2026,
   Identity-Center-Login. Alle 671 geprüften eingehenden Nachrichten bestehen die SDK-Schemas (Werkzeug: `npm run validate-wire`).
4. Quelltext von `@agentclientprotocol/sdk` 2.0.1.

Wo deine CLI abweicht, gilt deine CLI. Was noch fehlt, steht als `[P]` in den Notizen (Abschnitt 17 dort).

## 2. Die wichtigsten Erkenntnisse

Details und Belege in `protocol-notes.md`, Abschnitt 16. `[V]` = auf deiner Maschine bestätigt.

1. **`protocolVersion: 1` funktioniert** `[V]`. Kiro antwortet mit 1; T3 Code sendet 2 und bekommt 2. Das stabile SDK (v1)
   genügt, das experimentelle v2 brauchen wir nicht. Risiko R1 ist damit geschlossen.
2. **Das SDK verwirft Nachrichten still.** Sein interner Router prüft jede `session/update` streng, bevor mein Code
   sie sieht; schlägt die Prüfung fehl, geht die Nachricht verloren. Deine echten Nachrichten bestehen die Prüfung, aber
   eine künftige CLI kann neue Update-Typen senden. Deshalb leitet die Extension `session/update` und alle
   `_*`-Notifications auf Stream-Ebene in einen eigenen, toleranten Dispatcher um (die Probe macht das bereits so).
   Die SDK-Hilfe `buildSession()` scheidet aus, weil Kiro Updates **vor** der `session/new`-Antwort sendet.
3. **Supervised/Autopilot ist eine Config-Option** (`autopilot` = `on`/`off`), kein eigener Modus `[V]`. Im Supervised-Modus
   kommt am Turn-Ende eine zweite Freigabe „Review changes“ (`turn_approval`) `[V]`.
4. **Autopilot heißt nicht „keine Rückfragen“.** In den Aufzeichnungen fragt Kiro auch mit `autopilot: on` bei
   Schreibzugriffen (`askType: "implicit"`). Daraus folgt Entscheidung E1 (Abschnitt 7). Auf deiner
   Maschine ist das noch nicht nachgestellt (Lauf `--autopilot on`).
5. **Kiro schreibt Dateien über den Client, wenn man `fs` anbietet** `[V]`: Existenzprüfung per `fs/read_text_file`, dann
   `fs/write_text_file`, Rücklesen, danach „Review changes“. Die Extension kann also Schreibzugriffe zurückhalten,
   Diffs und Hunks zeigen und ungespeicherte Editor-Inhalte liefern. Offen: was „Reject changes“ bewirkt (Lauf `--review reject`).
6. **`model` erscheint ungefragt etwa 0,4 s nach `session/new`** `[V]`, nicht in der `session/new`-Antwort. `effortLevel`
   gibt es nur bei Modellen mit Effort. Die Modellliste hängt vom Konto ab (bei dir 8 Modelle, in den Aufzeichnungen 21).
7. **Abbrechen kann wirkungslos sein**, wenn es zu früh kommt. `session/cancel` ist eine Notification und wird erst
   nach `turn_start` gesendet.
8. **Die `_kiro/*`-Liste weicht von deinem Prompt ab** `[V]`: keine Request-Methoden für `mcp/status`, `hooks/list`,
   `account/getUsage`, `session/rename`, `_session/steer`. **MCP-Status, Tool-Kategorien, Steering-Dokumente (mit Inhalt)
   und die Session-Liste kommen stattdessen als Broadcasts**, deren Nutzlasten jetzt dokumentiert sind. Das Kiro-Panel kann
   live aus Push-Nachrichten gespeist werden. Die UI hängt an „was die installierte CLI anbietet“.
9. **Hooks brauchen ein Opt-in des Clients** (`clientCapabilities._meta.kiro.hooks`), sonst lädt V3 keine Hooks.
10. **Es gibt kein `/spec` in `available_commands_update`**; Spec-Workflows sind Modi (`spec`, `quick-spec`,
    `bug-fix`). Der Assistent „Neue Spec“ setzt also zuerst den Modus.
11. **Start und Ende unter Windows** `[V]`: `initialize` dauerte 4,7 s, `session/new` 17 s; die CLI beendete sich nach
    `session/close` und geschlossenem stdin nicht von selbst. Nötig sind großzügige Timeouts, ein „Verbinde…“-Zustand und
    das Beenden des ganzen Prozessbaums (R14, R15).
12. **Benachrichtigungen für eine neue Session kommen, bevor `session/new` die Session-ID liefert** `[V]`. Der Dispatcher
    muss sie puffern (R16).

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
| SDK-Einstiegspunkt | Stabil (v1); `/unstable` nur bei Bedarf | v1 funktioniert `[V]`, v2 entfällt. `session/fork` und `session/delete` gibt es als typisierte Methoden nur unter `/unstable`; entschieden wird in Phase 2, wenn die Fork-Parameter bekannt sind. Einen Einstiegspunkt konsequent verwenden. |
| Eigene Schicht über dem SDK | Umleitung + toleranter Dispatcher | siehe Erkenntnis 2 |
| Extension-Bundle | esbuild, CJS, SDK mit eingebündelt | Die Extension liefert kein `node_modules` aus. Wichtig: Das Wurzel-`package.json` bekommt **kein** `"type": "module"`, sonst lädt VS Code das CJS-Bundle als ESM. Skripte unter `scripts/` sind ESM über ein eigenes `scripts/package.json`. |
| Webview | React, Vite, `react-markdown` + `remark-gfm`, Shiki (JS-Regex-Engine), Mermaid lazy, `react-virtuoso`, Zustand | wie im Prompt; `@vscode/webview-ui-toolkit` bleibt tabu. |
| Tests | Vitest, `@vscode/test-cli`, Fake-Agent über In-Memory-Streams | wie im Prompt. Aufzeichnungen Dritter nur lokal als Gegenprobe, bis die Lizenzfrage (MIT, Namensnennung) sauber gelöst ist; Fixtures kommen aus Probe-Ausgaben oder sind handgeschrieben. |
| Protokoll-Log | Output-Channel „Kiro Studio: Protocol“, Schwärzung (Tokens, E-Mail, Home-Pfad) | Die Schwärzfunktion der Probe wandert nach `src/util/redact.ts`. |
| Lizenz | **Apache-2.0** (`LICENSE`, `package.json`) | Entscheidung E5. Das gebündelte SDK steht ebenfalls unter Apache-2.0; die Lizenztexte der gebündelten Pakete kommen beim Packaging in Phase 1 in die `.vsix`. |

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
  (über die VS-Code-API: offene, ungespeicherte Editoren zuerst, fehlende Datei als `-32002`), `_kiro/openExternalUrl`.
  `fs` wird angeboten, weil Kiro es nutzt `[V]`; `terminal` erst, wenn der Lauf `--terminal` gezeigt hat, was Kiro damit tut.
- Verbindung unter Windows: `initialize` ≥ 60 s und `session/new` ≥ 120 s Zeitlimit, sichtbarer „Verbinde…“-Zustand; Beenden
  mit `session/close`, stdin schließen, dann den Prozessbaum beenden (`taskkill /T`), falls die CLI nicht selbst endet.
  Der Dispatcher nimmt Notifications mit noch unbekannter Session-ID an und hält sie, bis `session/new` antwortet.
- Statusleiste mit Quick-Menü, Onboarding (Willkommensansicht + Walkthrough), Workspace-Trust-Sperre.
- Vorläufige Freigabe-UI per QuickPick und ein Debug-Befehl „Prompt senden“, damit die Verbindung ohne Chat testbar ist.
- **Abnahme:** Tests grün; mit deiner CLI: verbinden, Session anlegen, Prompt senden, Freigabe beantworten,
  Prozess abschießen und wiederaufnehmen. Windows-, macOS- und Linux-Pfade in der CI-Matrix.
- **Voraussetzung:** Probe-Läufe aus Abschnitt 8 (mindestens `--review reject`, `--autopilot on`, `--exit-wait 30`). Lauf 1 liegt vor.
  Du warst unterwegs und konntest keine weiteren Läufe machen; Phase 1 wurde deshalb mit dokumentierten Annahmen gebaut
  (Abschnitt 9) und durch den Fake-Agenten abgesichert.

### Phase 2 – Chat

- Chat-WebviewView im eigenen Activity-Bar-Container (in die sekundäre Seitenleiste verschiebbar), optional Editor-Tab,
  Sessions als Tabs; Streaming mit Markdown, Code-Highlighting, Mermaid; „Thinking“ einklappbar, falls Kiro es sendet.
- Tool-Karten (Icon je `kind`, Status, klickbare Dateien, Terminal-Ausgabe, `+x −y`, „Diff öffnen“ per `vscode.diff`
  über einen virtuellen Dokument-Provider; `file://`-Pfade normalisieren; `oldText: ""` als neue Datei behandeln).
  Der Status eines Tool-Calls ist nicht monoton; „wartet auf Freigabe“ kommt aus der Freigabe-Queue, nicht aus `status`.
- Inline-Freigaben mit genau den angebotenen Optionen (nach `kind` gewählt), einschließlich der „Review changes“-Freigabe;
  `allow_always` mit Hinweis, dass Kiro daraus eine dauerhafte Regel macht.
- Schreibzugriffe laufen über `fs/write_text_file` `[V]`: Die Extension hält die Antwort bis zur Entscheidung zurück, zeigt den
  Diff (bei neuen Dateien steht der Inhalt schon im ersten `tool_call`) und schreibt erst dann, Hunks einzeln. Wie Kiro auf eine
  Ablehnung oder eine lange Wartezeit reagiert, klärt `--review reject`; bis dahin ist das ein Plan, kein Versprechen.
- Supervised/Autopilot-Umschalter (Config-Option `autopilot`), Verhalten laut Entscheidung E1.
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
MCP-Status, Steering-Dokumente und Session-Liste live aus den Broadcasts `_kiro/mcp/status`, `_kiro/steering/documents_changed`
und `_kiro/sessions/changed` `[V]` (Teilobjekte nach `sessionId` zusammenführen); Hook-Zustand erst nach dem Opt-in (Entscheidung E4).

### Phase 4 – Specs

Assistent „Neue Spec“ (zuerst Modus setzen, dann strukturierter Prompt), Spec-Ansicht mit Tabs, Mermaid und
Fortschritt, CodeLens und Task-Ausführung, Review. Das `tasks.md`-Format sollte an einer **echten** Kiro-Spec ermittelt
werden (E3); bis dahin gilt A19 (Abschnitt 12).

### Phase 5 – Feinschliff

Themes (hell, dunkel, High Contrast), Barrierefreiheit, Performance bei langen Chats, Lokalisierung, README mit Screenshots, `.vsix`. Gebaut, siehe Abschnitt 13.

## 6. Risiken

| # | Risiko | Wirkung | Gegenmaßnahme |
| --- | --- | --- | --- |
| R1 | ~~Kiro verlangt `protocolVersion: 2`.~~ **Geschlossen:** Kiro akzeptiert und beantwortet 1 `[V]`. | – | Das stabile SDK genügt. |
| R2 | Das SDK verwirft eine unbekannte `session/update` still. | Verlorene Updates, Zustand falsch. | Umleitung auf Stream-Ebene (eingebaut in die Probe, in Phase 1 als Test). |
| R3 | `_kiro/*`-Angebot unterscheidet sich je CLI-Version. | Funktionen fehlen oder brechen. | Alles über `extensionMethods` und beobachtete Broadcasts freischalten, nie über die Version; UI mit Leerzustand je Funktion. |
| R4 | Unklar, wie Kiro auf eine verzögerte oder verweigerte `fs/write_text_file`-Antwort und auf „Reject changes“ reagiert. (Dass Kiro `fs/*` nutzt, ist bestätigt `[V]`.) | Hunk-Review vor dem Schreiben funktioniert evtl. nur eingeschränkt. | Lauf `--review reject`; Allow/Deny mit Diff-Vorschau und Schatten-Repo als Rückfallebene (Entscheidung E2). |
| R5 | Protokollfakten stammen teils aus Drittquellen und einer älteren CLI. | Falsche Annahmen. | Belegstufen in den Notizen; Probe auf deiner CLI; Integrationstests gegen die echte CLI als manueller Schritt. |
| R6 | Spät und ungeordnet eintreffende Config-Updates, wirkungslose frühe Writes. | Falscher Modell-/Effort-Stand. | Schreibreihenfolge und Verwerfen veralteter Antworten im Session-Store, mit Tests. |
| R7 | Frühes `session/cancel` wird ignoriert. | Abbrechen wirkt nicht. | Erst nach `turn_start` senden, begrenzte Wartezeit, UI zeigt „bricht ab…“ bis zur Antwort. |
| R8 | Hook-Opt-in ändert das Verhalten (globale Hooks laufen). | Überraschende Befehle. | Opt-in nur bewusst (Entscheidung E4: Einstellung, Standard aus), nie im Probe-Standardlauf. |
| R9 | Entwicklung kostet Credits. | Kosten. | Fake-Agent für Tests; Probe mit `--no-prompt` ist kostenlos. |
| R10 | Windows: Pfade kommen in drei Schreibweisen (klein geschriebener Laufwerksbuchstabe mit Backslashes, `file:///c%3A/…`, doppelt kodiert in `kiro-snapshot-v2://`), außerdem `.cmd`-Wrapper und CRLF. | Pfadvergleiche und Diffs schlagen nur unter Windows fehl. | Pfadnormalisierung zentral und früh testen, CI-Matrix, `kiro-cli.exe` bevorzugen. Installationsort ist bekannt: `%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe` `[V]`. |
| R11 | Sehr lange Chats, große `rawOutput`/`preview`-Nutzlasten. | Webview träge, Nachrichten über dem SDK-Größenlimit. | Virtualisierung, gekürzte Darstellung, Nachrichtenlimit konfigurieren und messen. |
| R12 | Namens- oder Markenprobleme („Kiro“). | Beanstandung beim Veröffentlichen. | Eigener Name und Icon, deutlicher Hinweis „inoffiziell“, keine Kiro-Assets. |
| R13 | Das SDK ändert sich (v2 ist ein Entwurf, 2.x kann Brüche bringen). | Wartungsaufwand. | SDK exakt pinnen, ACP-Schicht klein und hinter eigenen Typen halten. |
| R14 | Langsamer Start: `initialize` 4,7 s, `session/new` 17 s unter Windows `[V]`. | Wirkt wie ein Hänger; zu knappe Zeitlimits brechen den Start ab. | Zeitlimits ≥ 60 s / 120 s, „Verbinde…“-Zustand, Verbindung früh und im Hintergrund aufbauen. |
| R15 | Die CLI endet nicht, wenn stdin schließt `[V]`; ihr Agent-Server läuft als Kindprozess. | Verwaiste Prozesse nach dem Deaktivieren oder Beenden von VS Code. | Beenden des Prozessbaums (`taskkill /T` unter Windows), Test, ob nach dem Beenden Prozesse übrig bleiben. Lauf `--exit-wait 30`. |
| R16 | Notifications (auch `session/update` und `_kiro/*`) kommen vor der `session/new`-Antwort `[V]`. | Verlorene oder falsch zugeordnete Updates. | Dispatcher akzeptiert unbekannte Session-IDs und hält die Nachrichten, bis `session/new` antwortet; Test mit dem Fake-Agenten. |

## 7. Entscheidungen und offene Fragen

### Entschieden (2026-10-23)

- **E1 – Freigaben im Autopilot: automatisch erlauben (bestätigt am 2026-10-23, „Automatisch erlauben bitte“).** Ist der
  Autopilot an, beantwortet die Extension **jede** Berechtigungsanfrage von Kiro, die „einmal erlauben“ (`allow_once`)
  anbietet, selbst mit `allow_once`, unabhängig vom `askType`. Dabei gilt: nie automatisch eine dauerhafte Option
  (`allow_always`, `reject_always`) wählen; jede automatische Antwort im Chat sichtbar protokollieren („Automatisch
  erlaubt“); im Supervised-Modus immer fragen; als Einstellung abschaltbar (`kiroStudio.autoAllowInAutopilot`). Die
  Prüfung am Turn-Ende („Review changes“) ist keine Berechtigung, sondern eine Bewertung des Ergebnisses; sie und
  Anfragen ohne „einmal erlauben“ zeigt die Extension weiter dir. Kiros eigene Deny-Regeln bleiben wirksam, weil Kiro
  dafür gar nicht erst nachfragt; Kiros Ask-Regeln werden im Autopilot dagegen mit „einmal erlauben“ beantwortet.
- **E2 – Checkpoints:** Schatten-Git-Repo als verlässliche Basis für Revert und „View all changes“. Kiros eigene Checkpoints
  prüfe ich später und nutze sie höchstens als Zusatz.
- **E3 – Beispiel-Spec:** zurückgestellt. Du kennst Specs noch nicht (Erklärung in der Antwort vom 2026-10-23). Phase 4 ist
  trotzdem gebaut, mit dem Format aus Beschreibungen Dritter (Annahme A19, Abschnitt 12); eine echte Datei von Kiro prüft sie.
- **E4 – Hooks: Opt-in.** Kiro Studio aktiviert Hooks nur, wenn du es einschaltest (Einstellung `kiroStudio.hooks.enabled`,
  Standard aus), mit Hinweis, dass dann auch deine globalen Hooks laufen. Details in Phase 3.
- **E5 – Lizenz: Apache-2.0.** `LICENSE` und `package.json` sind angelegt.

### Offen

1. **Weitere Probe-Läufe.** Lauf 1 ist ausgewertet. Für Phase 1 und 2 fehlen noch `--review reject`, `--autopilot on` und
   `--exit-wait 30 --no-prompt`; Befehle in Abschnitt 8. Ein Lauf mit Prompt kostete bei dir rund 0,1 Credit, `--no-prompt`
   nichts. Schick mir wieder `summary.json` und `wire.ndjson` (vorher durchsehen). Alternativ schaltest du `kiro.dev` und
   `agentclientprotocol.com` in den Umgebungseinstellungen frei, dann lese ich die Doku selbst.
2. ~~Freigabe für Phase 1.~~ Erteilt (2026-10-23, „Du hast mein Go“).
3. ~~Publisher-ID und Copyright-Name.~~ Entschieden: `lldeters` (Publisher in `package.json`, Copyright-Zeile in `NOTICE`). Das
   Repo ist bereits öffentlich; `probe-logs/` ist ausgeschlossen, damit keine Konto-Daten hochgeladen werden.
4. **Beispiel-Spec** (E3): eine von Kiro geschriebene `tasks.md` (am besten mit `requirements.md` und `design.md`) würde A19
   bestätigen oder korrigieren. Phase 4 läuft auch ohne.

## 8. Probe ausführen

Voraussetzungen: Node 20+, installierte und angemeldete Kiro CLI (`kiro-cli whoami`). Wer die Probe schon einmal gestartet
hat, holt zuerst den neuen Stand: `git pull` und `npm ci`.

```bash
git clone https://github.com/lldeters/kiro-studio.git && cd kiro-studio   # Standard-Branch main
npm ci
npm run probe                      # voller Lauf, ein Mini-Prompt, Supervised
```

Nächste Läufe (jeweils eigener Ordner unter `probe-logs/`; Lauf 1 ist erledigt):

```bash
npm run probe -- --review reject              # was passiert bei "Reject changes"? schreibt Kiro die alte Datei zurück?
npm run probe -- --autopilot on               # was wird im Autopilot noch gefragt?
npm run probe -- --exit-wait 30 --no-prompt   # beendet sich die CLI irgendwann von selbst, wenn stdin zu ist?
npm run probe -- --hooks --no-prompt          # Hook-Verkehr sehen (kann globale Hooks starten)
npm run probe -- --terminal --prompt "Run the command: node --version"
                                              # Form der Freigabeanfrage für einen Befehl (wird abgelehnt)
```

Die Probe arbeitet in einem frischen Temp-Ordner und erlaubt Freigaben nur einmalig und nur, wenn alle genannten Pfade
darin liegen (`--approve none` lehnt alles ab). Ergebnis: `summary.json` (Zusammenfassung), `wire.ndjson` (jede Zeile auf
der Leitung, vor dem SDK-Parsing), `stderr.log`. Der Ordner `probe-logs/` ist von Git ausgeschlossen. `npm run validate-wire -- probe-logs/<Lauf>/wire.ndjson` prüft die Nachrichten gegen die Schemas des SDK.

## 9. Phase 1: Stand, Annahmen und gewählte Voreinstellungen

### Was gebaut ist

- Gerüst: Build (esbuild, ein CJS-Bundle mit eingebettetem SDK), strikte TypeScript-Konfiguration, ESLint (mit Regel „nur
  `src/host` und `src/extension.ts` dürfen `vscode` importieren“), Prettier, Vitest, `@vscode/test-cli`, `vsce`,
  GitHub-Actions-Matrix, Texte auf Englisch und Deutsch (Manifest und Laufzeit, mit Abdeckungstest).
- `kiro/cli.ts`: Suche (Einstellung → `KIRO_CLI_PATH` → PATH → Login-Shell → bekannte Orte), `--version`, `acp --help`
  (V3 vorhanden?), `whoami`, Login im VS-Code-Terminal. Zustände *fehlt / zu alt / nicht angemeldet / Fehler / bereit*.
  `doctor` wird noch nicht aufgerufen (kein Bedarf bisher).
- ACP-Schicht: Verbindung mit Rohlog, Umleitung, Dispatcher mit Puffer für zu frühe Notifications, Session-Store mit
  Turn-Automat, Freigaben (Regel E1), `fs` mit Pfadwächter, Neustart mit Backoff, Wiederaufnahme per `session/load`,
  Abbrechen erst nach `turn_start`, Beenden des Prozessbaums.
- VS-Code-Anbindung: Statusleiste mit Quick-Menü, Kiro-Ansicht (Status, Verbindung, Sessions), Willkommensansichten und
  Walkthrough, Workspace-Trust-Sperre, Freigabe-Dialog (QuickPick), Debug-Befehle (neue Session, Prompt senden, abbrechen),
  Befehle zum Prüfen, Neustarten, Anmelden, CLI-Pfad setzen, Autonomie umschalten, Logs zeigen.
- Tests: Unit-Tests gegen den Fake-Agenten und gegen eine echte Fake-CLI, Integrationstests in VS Code (laufen in der CI).

### Annahmen (nicht auf deiner CLI geprüft)

| # | Annahme | Was passiert, wenn sie falsch ist |
| --- | --- | --- |
| A1 | „Reject changes“ am Turn-Ende ist eine normale Antwort mit der Option `reject_once`; Kiro stellt danach nicht selbständig Dateien wieder her. | Die Extension zeigt weiter genau die angebotenen Optionen. Eine mögliche Wiederherstellung durch Kiro fiele uns erst im Lauf `--review reject` auf. Revert über das Schatten-Repo kommt in Phase 2. |
| A2 | Im Autopilot sendet Kiro keine „Review changes“-Anfrage am Turn-Ende (so liest sich die Doku und passt zu den Aufzeichnungen); `--autopilot on` hat es nicht bestätigt. | Kommt sie doch, zeigt die Extension sie dir (Entscheidung E1) und fragt nicht automatisch. |
| A3 | Die CLI beendet sich nach geschlossenem stdin nicht zuverlässig. | Nach 5 s Gnadenfrist wird der Prozessbaum beendet. Beendet sie sich doch, passiert nichts weiter. |
| A4 | Abgemeldet bedeutet: `whoami` endet mit Fehler oder liefert kein JSON in der ersten Zeile. | Im schlimmsten Fall steht „bereit“ oder „nicht angemeldet“ im falschen Zustand; die Statusanzeige und „Einrichtung prüfen“ zeigen den Fehler dann beim ersten Verbinden. |
| A5 | `terminal` bleibt abgeschaltet; Hooks laufen nur mit Opt-in. Der Hook-Verkehr nach dem Opt-in ist nicht beobachtet. | Hook-Nachrichten werden ignoriert, solange kein Code sie auswertet (Phase 3). |
| A6 | Der Host-Code (Statusleiste, Befehle, Dialoge) ist nur typgeprüft und durch die Integrationstests in der CI abgedeckt, nicht von mir in einem echten VS Code gesehen. | Darstellungsfehler sind möglich, siehe unten „Abnahme bei dir“. |

### Voreinstellungen, die ich gewählt habe

- `kiroStudio.autonomy`: **supervised** (nicht Autopilot). Neue Sessions fragen also nach. Nur auf Anwendungsebene: Weil
  die automatische Freigabe vorab an ist, darf ein Repository Autopilot nicht per `.vscode/settings.json` einschalten.
  Dasselbe gilt für `kiroStudio.defaultMode` (sonst könnte es einen eigenen Agenten wählen).
- `kiroStudio.autoAllowInAutopilot`: **an**, wirkt aber nur im Autopilot und nur als `allow_once` (Entscheidung E1). Die Einstellung gilt
  nur auf Anwendungsebene, ein Repository kann sie nicht per `.vscode/settings.json` einschalten.
- `kiroStudio.hooks.enabled`: **aus** (Entscheidung E4), ebenfalls nur auf Anwendungsebene.
- `kiroStudio.cliPath`: nur auf Maschinenebene, aus demselben Grund.
- `kiroStudio.logging.level`: `messages` (Protokoll zeigt Nachrichten in Kurzform, `verbose` zeigt alles; Tokens, E-Mail und Home-Pfad sind immer geschwärzt).
- Der Agent startet erst bei der ersten Verwendung, nicht beim Start von VS Code.

### Abnahme bei dir (sobald du wieder am Rechner bist)

1. `git pull`, `npm ci`, `npm run build`, F5 („Run Extension“). In der Statusleiste sollte *Kiro* mit Häkchen stehen.
2. „Kiro Studio: Debug: New Session“, danach „Debug: Send Prompt“; die Antwort erscheint im Ausgabekanal „Kiro Studio: Chat (debug)“.
3. Eine Freigabe beantworten, VS Code schließen und prüfen, dass kein `kiro-cli`-Prozess übrig bleibt.
4. Optional die Probe-Läufe `--review reject`, `--autopilot on`, `--exit-wait 30 --no-prompt` aus Abschnitt 8.

## 10. Phase 2: Stand, Abweichungen und Annahmen

### Was gebaut ist

- **Chat-Ansicht** (Webview, React/Vite) in der Seitenleiste und als Editor-Tab; Sitzungen als Tabs; Streaming mit
  Markdown (GFM, kein rohes HTML), Code-Highlighting (Shiki, JS-Engine, lazy), Mermaid (lazy, erst wenn der Text ruht),
  „Thinking“ (aufgeklappt, solange es streamt, danach zugeklappt), „Kiro denkt nach …“ solange ein Durchlauf noch
  nichts zeigt, Tool-Karten (Icon je `kind`, Datei, `+x −y`, Status, Eingabe/Ausgabe, Diff), Plan,
  virtualisierte Liste, die nur mitläuft, wenn man unten ist. Helles und dunkles Theme geprüft (Screenshots per
  `npm run preview`).
- **Freigaben im Chat** mit genau den angebotenen Optionen, Diff-Vorschau bei Schreibzugriffen, „Immer“-Optionen mit
  Hinweis auf die dauerhafte Regel; der QuickPick bleibt zu, solange der Chat sichtbar ist.
- **Eingabe-Box und Zeile darunter** (nach dem Vorbild des VS-Code-Chats, mit lila Akzent): in der Box Kontext (`+`),
  Agent, Modell, Effort und Senden/Stopp; darunter Supervised/Autopilot, Kontext-Füllstand, Credits des letzten
  Durchlaufs, „Kontext komprimieren“ (nur wenn `_kiro/session/compact` angekündigt ist), Export als Markdown; darüber ein
  Chip mit den letzten Änderungen von Kiro.
- **Eingabe:** Enter/Shift+Enter/Esc, `/`-Befehle aus `available_commands_update`, `#file`, `#folder`, `#current`,
  `#problems`, `#git diff`, `#steering`, `#spec`, Bilder per Einfügen oder Ablegen (nur wenn die CLI sie annimmt),
  Dateien aus dem Explorer per Ablegen; Entwürfe pro Sitzung, auch nach dem Ausblenden der Ansicht.
- **Diffs:** „Diff öffnen“ im nativen Diff-Editor über virtuelle Dokumente (nichts wird geschrieben).
- **Checkpoints:** Schatten-Git-Repo (E2), Schnappschuss vor und nach jedem Durchlauf, Karte „Kiro hat N Dateien
  geändert“ mit „Änderungen ansehen“ (Mehrfach-Diff) und „Zurücknehmen“ (alles oder je Datei, mit Rückfrage und
  Konfliktschutz für Dateien, die du seitdem geändert hast). Dein eigenes Repository wird nie angefasst.
- **Export** der Sitzung als Markdown-Dokument.

### Abweichungen vom Phasenplan (und warum)

| Geplant | Umgesetzt | Grund |
| --- | --- | --- |
| Schreibzugriff über `fs/write_text_file` zurückhalten, Hunks einzeln freigeben | Diff-Vorschau in der Freigabe-Frage; keine Hunk-Freigabe | Kiro fragt die Berechtigung **vor** dem Schreiben `[V]`, die Vorschau reicht also zum Entscheiden. Teile eines Schreibvorgangs wegzulassen würde den Inhalt ändern, den Kiro danach zurückliest; ob es das verträgt, ist ungeprüft. |
| `#terminal`, `#url` | nicht umgesetzt | `#terminal` braucht die Ausgabe des Terminals (Shell-Integration) und ist ein eigener Aufwand; URLs kann man in den Text schreiben. |
| Steer (`_session/steer`) | nicht umgesetzt | Wird von der CLI nicht angekündigt `[V]`. |
| „Rewind to here“ (`session/fork`) | zurückgestellt | Parameter unbekannt, nur im `/unstable`-Teil des SDK. „Zurücknehmen“ je Durchlauf und Datei ist da. |
| Export | eigenes Markdown aus dem Chat | `_kiro/session/export` ist zwar angekündigt, sein Format ist ungeprüft. |
| Sitzungsliste, alte Sitzungen öffnen | Phase 3 | gehört zum Kiro-Panel. |

### Annahmen (nicht auf deiner CLI geprüft)

| # | Annahme | Was passiert, wenn sie falsch ist |
| --- | --- | --- |
| A7 | `_kiro/session/compact` nimmt `{ sessionId }` an. | Die Schaltfläche zeigt eine Fehlermeldung im Chat; sie erscheint nur, wenn die CLI die Methode ankündigt. |
| A8 | Kiro versteht `resource_link`-Blöcke (Dateien, Ordner) und `image`-Blöcke im Prompt (ACP-Standard). | Anhänge kommen nicht an. Die Anzeige im Chat stimmt dann trotzdem; die Antwort von Kiro würde es verraten. |
| A9 | Ein Prompt `/name args` wird von Kiro als Befehl erkannt, die Namen in `available_commands_update` stehen ohne `/`. | Der Befehl läuft als normaler Text. |
| A10 | Der VS-Code-Befehl `vscode.changes` öffnet den Mehrfach-Diff. | Es erscheint eine Dateiliste, aus der man eine Datei wählt. |
| A11 | Git ist installiert. Unter Windows lange Pfade, Zeilenenden und Sonderzeichen in Dateinamen laufen wie unter Linux. | Fehlt Git, schalten sich Checkpoints einmalig mit Hinweis ab. Die Tests laufen mit echtem Git auch auf Windows und macOS (CI). |
| A12 | Was „Reject changes“ am Turn-Ende in Kiro auslöst, ist unbekannt (A1); Checkpoints sind davon unabhängig, weil sie Dateibäume vergleichen. | Nach „Reject“ zeigt die Karte die Änderungen an, die Kiro vielleicht selbst zurückgenommen hat; „Zurücknehmen“ meldet dann nichts zu tun oder einen Konflikt. |

### Voreinstellungen, die ich gewählt habe

- `kiroStudio.checkpoints.enabled`: **an**. Der Schatten-Speicher liegt im globalen Speicher der Extension, nicht im Projekt.
- Ausgeschlossen aus Checkpoints: `.gitignore` des Projekts plus `node_modules`, `dist`, `out`, `build`, `target`,
  `.venv`, `__pycache__`, `.vscode-test`.
- Nur der erste Arbeitsbereichsordner wird verfolgt; ohne Arbeitsbereichsordner gibt es keine Checkpoints.

### Abnahme bei dir (sobald du wieder am Rechner bist)

1. Wie bei Phase 1, dann **Kiro Studio** in der Aktivitätsleiste öffnen: „Neue Sitzung“, einen kleinen Auftrag geben
   („Lege eine Datei hello.txt mit einem Gruß an“).
2. Im Supervised-Modus: Freigabe-Frage mit Diff-Vorschau beantworten; am Ende die Karte „Kiro hat eine Datei geändert“ →
   „Änderungen ansehen“ → „Zurücknehmen“; die Datei verschwindet wieder.
3. Autopilot umschalten, nochmal einen Auftrag geben: es wird nicht mehr gefragt, im Chat steht „Automatisch erlaubt“.
4. Ansicht ausblenden und wieder einblenden (Entwurf bleibt), `#` und `/` in der Eingabe ausprobieren.

## 11. Phase 3: Stand, Abweichungen und Annahmen

### Was gebaut ist

Sechs Ansichten im Kiro-Studio-Container (unter dem Chat), gelesen aus den `.kiro`-Dateien und aus dem, was Kiro schickt:

- **Sitzungen:** `session/list` (alle Seiten) plus die Live-Updates `_kiro/sessions/changed` (Teilobjekte nach `sessionId`
  zusammengeführt) `[V]`; Standard: nur Sitzungen dieses Arbeitsbereichs, umschaltbar auf alle Ordner; Suche; Öffnen lädt
  die Sitzung samt Replay in einen Chat-Tab; Abzweigen und Umbenennen nur, wenn die CLI es anbietet.
- **Specs:** Spec-Ordner mit Anforderungen, Entwurf, Aufgaben und dem Fortschritt aus den Checkboxen von `tasks.md`.
- **Steering:** Dateien des Arbeitsbereichs und aus `~/.kiro` mit Einbindungsart (immer, bei passenden Dateien, auf Anfrage),
  dazu die eingebauten Dokumente aus dem Broadcast; neue Datei, löschen (in den Papierkorb), „Kiro schreiben lassen“.
- **Hooks:** Dateien mit Ereignis und Muster, ein-/ausschalten, neu; **laufen nur mit Opt-in** (Entscheidung E4), die Ansicht
  bietet den Schalter an und warnt, dass dann auch deine globalen Hooks laufen.
- **MCP:** Server aus `mcp.json` (Arbeitsbereich und `~/.kiro`) mit Live-Status; hinzufügen (immer zuerst ausgeschaltet),
  ein-/ausschalten, entfernen. Werte von `env` werden nie gelesen oder angezeigt, nur die Namen.
- **Agents:** die Agents der aktiven Sitzung (anklicken = verwenden) und deine eigenen Agent-Dateien; neu anlegen.

Dateiänderungen werden formatierungserhaltend geschrieben (Kommentare, Reihenfolge, Einrückung bleiben).

### Abweichungen vom Phasenplan (und warum)

| Geplant | Umgesetzt | Grund |
| --- | --- | --- |
| Spec-Assistent „Neue Spec“ | Phase 4 | gehört zum Spec-Workflow; Phase 3 zeigt und öffnet Specs. |
| Sitzung löschen | nicht umgesetzt | `session/delete` ist angekündigt, die Parameter sind ungeprüft. |
| Hook-Zustand live aus `_kiro/hooks/*` | Liste aus den Dateien | Die Nachrichten nach dem Opt-in sind nicht beobachtet `[P]`; die Ansicht aktualisiert sich bei jeder solchen Nachricht, zeigt aber nur Dateien. |
| MCP-Server neu starten | nicht umgesetzt | `_kiro/mcp/resetServer` wird nicht angekündigt `[V]`. |
| `~/.kiro` beobachten | liest beim Einblenden und Aktualisieren | VS Code beobachtet Ordner außerhalb des Arbeitsbereichs nicht verlässlich. |
| Powers, Wissensbasis, Memory | nicht im Plan, nicht umgesetzt | Die Methoden sind angekündigt, aber nicht Teil der Aufgabe. |

### Annahmen (nicht auf deiner CLI geprüft)

| # | Annahme | Was passiert, wenn sie falsch ist |
| --- | --- | --- |
| A13 | `session/list` ohne `cwd` liefert die Sitzungen aller Ordner. | Schlägt es fehl, wird mit dem Arbeitsbereichsordner erneut gefragt; „alle Ordner“ zeigt dann nur Sitzungen, die per Broadcast bekannt werden. |
| A14 | `session/fork` nimmt `{ sessionId, cwd, mcpServers: [] }` (ACP-Entwurf) und antwortet wie `session/new`. | „Abzweigen“ zeigt eine Fehlermeldung. Es erscheint nur, wenn die CLI die Fähigkeit ankündigt. |
| A15 | `_kiro/session/rename` nimmt `{ sessionId, title }`. | Die 2.33.1 kündigt die Methode gar nicht an; „Umbenennen“ erscheint dort nicht. |
| A16 | Formate von `.kiro.hook`, Agent-JSON, `mcp.json` und der Steering-Frontmatter entsprechen dem, was die Kiro-IDE schreibt; `tasks.md` hat Checkbox-Zeilen (seit Phase 4 siehe A19). | Dateien, die nicht passen, erscheinen trotzdem in der Liste, mit Fehlertext bzw. ohne Fortschritt. |
| A17 | Einträge von `_kiro/mcp/status` haben Name und Status (unter üblichen Schlüsseln); beobachtet wurde nur die leere Liste. | Server ohne erkennbaren Status zeigen „nicht gestartet“; die Konfiguration bleibt sichtbar. |
| A18 | Eingebaute Steering-Dokumente tragen im Broadcast eine `uri` mit `builtin:`; Dateien des Nutzers erkenne ich an den Dateien selbst. | Eingebaute Dokumente erscheinen nicht, oder Dateien doppelt; die Dateiansicht bleibt richtig. |

### Voreinstellungen, die ich gewählt habe

- Die Ansichten „Sitzungen“ ist offen, die anderen fünf sind eingeklappt.
- Sitzungen: nur dieser Arbeitsbereich (Umschalter in der Titelleiste).
- Ein neuer MCP-Server wird **ausgeschaltet** angelegt, ein neuer Hook ebenfalls.
- Der Agent startet nicht beim Einblenden der Ansicht „Sitzungen“; sie wartet, bis eine Sitzung läuft.

### Abnahme bei dir

1. In einem Projekt mit `.kiro`-Ordner (oder einem neuen): die fünf Datei-Ansichten aufklappen, „Neue Steering-Datei“ anlegen.
2. „Kiro schreiben lassen“ in der Steering-Ansicht: Kiro soll `product.md`, `tech.md`, `structure.md` anlegen.
3. Eine Sitzung starten, dann in „Sitzungen“ eine frühere öffnen (das Gespräch erscheint im Chat).
4. MCP: „Server hinzufügen“, dann einschalten und eine neue Sitzung starten; der Status sollte sich ändern.

## 12. Phase 4: Stand, Abweichungen und Annahmen

### Was gebaut ist

- **Aufgaben aus `tasks.md`:** Der Parser macht aus der Datei einen Baum (Nummer, Titel, Unteraufgaben, `[ ]` / `[-]` / `[x]`,
  optionale Aufgaben `- [ ]*`, Detailzeilen, `_Requirements: 1.1, 2.3_`). Der Fortschritt zählt die Aufgaben ohne
  Unteraufgaben; eine optionale Aufgabe zählt nur, wenn sie erledigt ist, damit eine Spec ohne sie fertig sein kann.
  (Phase 3 zählte jede Checkbox, auch Elternaufgaben; das zeigte bei einer Aufgabe mit zwei Unteraufgaben „2 von 3“.)
- **Ansicht „Specs“:** unter dem Aufgabendokument stehen die Aufgaben mit Symbol je Zustand; „Aufgabe starten“ als Inline-Aktion,
  „Aufgaben aktualisieren“ am Aufgabendokument, „Spec-Ansicht öffnen“ an der Spec, „Neue Spec“ in der Titelleiste. Eine
  Fehlerbehebungs-Spec zeigt `bugfix.md`.
- **Assistent „Neue Spec“:** Art (Funktion mit Anforderungen zuerst, Funktion mit Entwurf zuerst, Fehlerbehebung, schnelle Spec),
  Beschreibung, Name (Vorschlag aus der Beschreibung, Kleinbuchstaben mit Bindestrichen, nicht vergeben). Dann eine eigene
  Sitzung im Agenten des Ablaufs (`spec`, `quick-spec`, `bug-fix`) und ein strukturierter Prompt, der Kiro nach jedem
  Dokument anhalten lässt.
- **CodeLens in `tasks.md`:** „Aufgabe starten“ (bzw. „Aufgabe fortsetzen“) über jeder offenen Aufgabe, „Aufgaben aktualisieren“
  oben (Einstellung `kiroStudio.specs.codeLens`, Standard an). Die Aufgabe wird beim Start in der Datei neu gesucht (Zeile, sonst
  Nummer); eine geänderte Liste startet nie die falsche Aufgabe.
- **Spec-Ansicht** (Editor-Tab): Dokumente als Tabs mit Markdown und Mermaid, Fortschritt, Aufgabenliste mit Start-Knöpfen,
  „Datei öffnen“ und je Dokument eine Prüfleiste: **Freigeben und weitermachen** oder **Änderungen anfordern…** (Text an Kiro).
  Sie lädt sich neu, wenn sich `.kiro` ändert. Tastatur: Pfeiltasten, Pos1 und Ende wechseln die Tabs.

### Abweichungen vom Phasenplan (und warum)

| Geplant | Umgesetzt | Grund |
| --- | --- | --- |
| `tasks.md`-Format an einer echten Kiro-Spec ermitteln (E3) | Format aus Beschreibungen Dritter, Parser tolerant | Es gab keine echte Datei, und die Kiro-Doku war von hier aus nicht erreichbar. Siehe A19. |
| „Review-Modus“ | Prüfleiste: Freigabe oder Änderungswunsch als Prompt | Ein Review-Mechanismus von Kiro für Specs ist im Protokoll nicht bekannt `[P]`. Fragt Kiro selbst, erscheint die Frage wie immer im Chat. |
| Task-Ausführung | Prompt an Kiro, kein eigener Task-Runner | Kiro schreibt den Zustand in `tasks.md`; die Extension liest ihn nur. |
| Spec-Ansicht mit Tabs, Mermaid, Fortschritt | wie geplant; Diagramme in Entwurf und Anforderungen | – |
| Spec-Assistent mit dem Modus `spec` | zusätzlich Entwurf-zuerst, Fehlerbehebung und schnelle Spec | Dieselbe Mechanik (Modus setzen, Prompt), drei weitere Abläufe der Kiro-IDE. |

### Annahmen (nicht auf deiner CLI geprüft)

| # | Annahme | Was passiert, wenn sie falsch ist |
| --- | --- | --- |
| A19 | `tasks.md` ist eine nummerierte Checkbox-Liste (`- [ ] 1. Titel`, Unteraufgaben `1.1` eine Ebene tiefer, `[-]` in Arbeit, `- [ ]*` optional, eingerückte Detailzeilen, `_Requirements: 1.1_`). Quelle: Beschreibungen des Spec-Ablaufs von Dritten, keine Datei von Kiro. | Zeilen, die nicht als Checkbox erkannt werden, erscheinen nicht als Aufgaben (kein Start-Knopf, kein Fortschritt). Eine andere Statusmarke gilt als „offen“. |
| A20 | Die Agents `spec`, `quick-spec` und `bug-fix` (auf deiner CLI als `mode` beobachtet `[V]`) tun, was der Name sagt; eine Fehlerbehebungs-Spec heißt `bugfix.md`. | Bietet die CLI den Agenten nicht an, steht ein Hinweis in der Sitzung und die Spec beginnt mit dem aktuellen Agenten. Ein anderer Dateiname fehlt in der Spec-Ansicht, bleibt aber in der Ordnerliste sichtbar. |
| A21 | Kiro hält sich an die Bitten im Prompt (nach jedem Dokument anhalten, nur diese Aufgabe, danach ankreuzen). | Kiro macht mehr oder weniger; die Extension liest den Zustand immer aus der Datei, nie aus dem Prompt. |
| A22 | Der Prompt „freigegeben, mach mit dem Entwurf weiter“ ist für Kiro ein gültiger Übergang zur nächsten Phase. | Kiro fragt nach oder bleibt stehen; die Antwort steht im Chat. |

### Voreinstellungen, die ich gewählt habe

- „Neue Spec“ läuft immer in einer **neuen Sitzung**; „Aufgabe starten“ und die Prüfleiste nutzen die aktive Sitzung, bei laufendem Durchgang fragt die
  Extension, ob eine neue Sitzung genommen werden soll.
- Der Agent wird nur gewechselt, wenn er sich vom Ablauf unterscheidet und die CLI ihn anbietet.
- Eine Aufgabe mit Unteraufgaben startet die Aufgabe samt Unteraufgaben nacheinander; eine ohne Unteraufgaben nur sich selbst.
- Die CodeLens ist an. Für „Aufgabe starten“ gibt es keine Bestätigungsabfrage; Kiros Freigaben (Supervised/Autopilot) gelten wie immer.

### Abnahme bei dir

1. „Neue Spec“ in der Specs-Ansicht: Art wählen, Satz beschreiben, Name bestätigen. Der Chat öffnet sich in einer neuen Sitzung im
   Agenten `spec`; Kiro soll `requirements.md` schreiben und anhalten.
2. In der Specs-Ansicht „Spec-Ansicht öffnen“: Tabs, Anforderungen lesen, **Freigeben und weitermachen**; Kiro soll `design.md`
   schreiben (Mermaid-Diagramme erscheinen gezeichnet), danach `tasks.md`.
3. `tasks.md` öffnen: über den offenen Aufgaben steht „Aufgabe starten“. Eine starten; Kiro soll sie erledigen und in der Datei
   ankreuzen, der Fortschritt in der Ansicht folgt.
4. Schick mir die `tasks.md` (und gern `requirements.md`/`design.md`) dieser Spec: Damit prüfe ich A19.

## 13. Phase 5: Stand, Abweichungen und Annahmen

### Was gebaut ist

- **Themes:** Hochkontrast-Themes bekommen Rahmen und Umrisse aus `contrastBorder`/`contrastActiveBorder` dort, wo andere Themes
  nur Farbe nutzen, unterstrichene Links und einen dickeren Fokusrahmen. Die Vorschau rendert `dark`, `light`, `hc`, `hc-light`.
- **Barrierefreiheit:** axe-core prüft Chat (alle Zustände) und Spec-Ansicht im Test. Gefunden und behoben: Bedienelemente in
  Bedienelementen (Schließen-Knöpfe in Tabs, Dateilink und Knöpfe in `<summary>`), eine Combobox-Rolle an einer Textarea, ein
  Eingabefeld ohne Label. Die Sitzungen sind jetzt eine Liste aus Knöpfen mit `aria-current`; Werkzeugaufrufe und Checkpoints sind
  eine `Disclosure`. Screenreader hören eine neue Frage sofort und das Ende eines Durchgangs höflich; die Statusleiste hat einen
  gesprochenen Text; das drehende Symbol steht bei „Bewegung reduzieren“.
- **Performance:** Antwort-Markdown wird blockweise gerendert (nur der wachsende Block wird neu berechnet); hervorgehobener Code
  und gezeichnete Diagramme werden zwischengespeichert. Messwerte (headless Chromium, Software-Rendering, ein Rechner, also
  Größenordnungen): Sitzung mit 1000 Durchgängen (rund 4000 Einträge, 2000 Werkzeuge): erster Inhalt nach 1,2 s, 150
  gestreamte Stücke kosten 0,6 s Skriptzeit (vorher 1,7 s), unabhängig von der Länge der Sitzung. Host-Seite: Ansicht der
  Sitzung rund 50 ms, ein Patch je Stück deutlich unter 1 ms; ein Test hält Budgets.
- **Lokalisierung:** Deutsch war vollständig (Test); neu sind die deutschen Seiten der Einführung (`*.de.md`).
- **Paket:** Icon (`resources/icon.png`, eigenes Motiv, erzeugt aus `resources/icon.svg`), Marketplace-Metadaten (Vorschau-Kennzeichen,
  Banner), README mit Screenshots und Abschnitten zu Datenschutz und Grenzen, `CHANGELOG.md`, `scripts/check-vsix.ts` prüft
  Inhalt, Größe (Grenze 5 MB, aktuell 2,2 MB) und README-Bilder und läuft am Ende von `npm run package` (also in der CI).

### Abweichungen vom Phasenplan (und warum)

| Geplant | Umgesetzt | Grund |
| --- | --- | --- |
| Farbkontrast prüfen | im Vorschau-Screenshot angesehen, nicht automatisch | axe braucht dafür eine Layout-Engine; jsdom hat keine. |
| Sehr lange Sitzungen | gemessen, Streaming optimiert | Der erste Inhalt einer 1000-Durchgänge-Sitzung braucht 1,2 s, weil die ganze Sitzung auf einmal ankommt. Nachladen älterer Einträge wäre eine größere Änderung am Protokoll; erst sinnvoll, wenn echte Sitzungen so lang werden. |
| Screenshots | aus der Vorschau (Beispieldaten), keine Aufnahme von VS Code | Ohne echtes VS Code mit Kiro nicht möglich; das README sagt es. Die Baumansichten (Panel) sind nicht abgebildet. |
| Veröffentlichen | nicht gemacht | Nicht verlangt. `"private": true` bleibt gesetzt; für eine Veröffentlichung wäre es zu entfernen. |

### Annahmen (nicht geprüft)

| # | Annahme | Was passiert, wenn sie falsch ist |
| --- | --- | --- |
| A23 | VS Code wählt für eine Einführungsseite `x.md` in einem deutschen Fenster `x.de.md`, wenn sie existiert (aus dem Verhalten der Einführungen von VS Code, nicht in einem echten Fenster gesehen). | Es erscheint die englische Seite. |
| A24 | Die Hochkontrast-Themes setzen `--vscode-contrastBorder` und `--vscode-contrastActiveBorder` und die Body-Klassen `vscode-high-contrast` bzw. `vscode-high-contrast-light`. | Die Umrisse fehlen; Lesbarkeit und Fokusrahmen bleiben, weil sie aus anderen Variablen kommen. |

### Voreinstellungen, die ich gewählt habe

- Das Paket ist als Vorschau gekennzeichnet (`"preview": true`).
- Die Sitzungsleiste verwendet keine Tab-Semantik mehr (Liste aus Knöpfen), damit jede Sitzung einen eigenen Schließen-Knopf haben darf.
- Werkzeugaufrufe und Checkpoint-Karten zeigen ihren Inhalt erst nach dem Aufklappen im DOM (weniger Arbeit beim Scrollen).

### Abnahme bei dir

1. Das Paket bauen (`npm run package`) und in VS Code installieren (`code --install-extension dist/kiro-studio.vsix`).
2. Ein Hochkontrast-Theme wählen: Chat und Spec-Ansicht sollten Umrisse zeigen, der Fokusrahmen ist gut sichtbar.
3. Mit einem Screenreader (NVDA, VoiceOver): in einem Durchgang bei einer Frage von Kiro sollte die Frage sofort vorgelesen werden,
   am Ende „Kiro: Fertig“.
4. VS Code auf Deutsch stellen: die Einführung sollte deutsch sein (A23).
5. Eine lange Sitzung öffnen und eine Antwort streamen lassen: kein Ruckeln.

## 14. Layout-Test: Chat als Editor-Tab (verworfen)

Am 2026-10-24 habe ich auf deinen Wunsch getestet, den Chat als **einen** Editor-Tab zu zeigen und die Seitenleiste nur als Menü zu
nutzen (Einstellung `kiroStudio.chatLocation`, Commit `379d145`). Du fandest das Layout davor besser, es wurde mit `git revert`
zurückgenommen: Der Chat bleibt die erste Ansicht der Seitenleiste „Kiro Studio“, darunter die Menü-Ansichten; ein Chat im
Editor-Tab bleibt über *Open Chat in Editor* möglich. Erhalten bleibt nur die Korrektur „Reverted one file“ statt „Reverted 1 files“.
Falls das Thema wiederkommt: Der Versuch steht im Verlauf (`git show 379d145`).

