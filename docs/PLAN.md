# Kiro Studio – Plan

Inoffizielle VS-Code-Extension, die die lokal installierte Kiro CLI über das Agent Client Protocol (ACP)
bedient. Nicht mit AWS oder Kiro verbunden.

**Status: Phase 0 und Phase 1 sind umgesetzt (Phase 1 siehe Abschnitt 9). Phase 1 ist gebaut, getestet und per CI geprüft,
aber noch nicht gegen deine echte CLI durchgespielt. Abnahme und ein paar kurze Probe-Läufe stehen aus (Abschnitte 8 und 9).**

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
Fortschritt, CodeLens und Task-Ausführung, Review-Modus. Das `tasks.md`-Format wird an einer **echten** Kiro-Spec
ermittelt (offen, E3), nicht aus der Doku geraten.

### Phase 5 – Feinschliff

Themes (hell, dunkel, High Contrast), Barrierefreiheit, Performance bei langen Chats, Lokalisierung, README mit Screenshots, `.vsix`.

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

- **E1 – Freigaben im Autopilot: automatisch erlauben.** Ist der Autopilot an, beantwortet die Extension Kiros Rückfragen
  selbst mit „einmal erlauben“ (`allow_once`). Dabei gilt: nie automatisch eine dauerhafte Option (`allow_always`,
  `reject_always`) wählen; jede automatische Antwort im Chat sichtbar protokollieren („Automatisch erlaubt“); im
  Supervised-Modus immer fragen; als Einstellung abschaltbar. **Meine Auslegung, bitte bestätigen:** Zunächst beantworte ich
  nur Anfragen automatisch, die Kiro als `askType: "implicit"` kennzeichnet (so wurde es beobachtet). Alles andere bleibt
  sichtbar, bis der Lauf `--autopilot on` zeigt, welche anderen Werte es gibt. Das hält deine ursprüngliche Vorgabe ein, Kiros
  eigene Ask-Regeln nicht auszuhebeln; wenn du wirklich jede Anfrage automatisch erlaubt haben willst, ist das eine kleine
  Änderung.
- **E2 – Checkpoints:** Schatten-Git-Repo als verlässliche Basis für Revert und „View all changes“. Kiros eigene Checkpoints
  prüfe ich später und nutze sie höchstens als Zusatz.
- **E3 – Beispiel-Spec:** zurückgestellt. Du kennst Specs noch nicht (Erklärung in der Antwort vom 2026-10-23); das ist erst
  für Phase 4 nötig und kein Hindernis für Phase 1 bis 3.
- **E4 – Hooks: Opt-in.** Kiro Studio aktiviert Hooks nur, wenn du es einschaltest (Einstellung `kiroStudio.hooks.enabled`,
  Standard aus), mit Hinweis, dass dann auch deine globalen Hooks laufen. Details in Phase 3.
- **E5 – Lizenz: Apache-2.0.** `LICENSE` und `package.json` sind angelegt.

### Offen

1. **Weitere Probe-Läufe.** Lauf 1 ist ausgewertet. Für Phase 1 und 2 fehlen noch `--review reject`, `--autopilot on` und
   `--exit-wait 30 --no-prompt`; Befehle in Abschnitt 8. Ein Lauf mit Prompt kostete bei dir rund 0,1 Credit, `--no-prompt`
   nichts. Schick mir wieder `summary.json` und `wire.ndjson` (vorher durchsehen). Alternativ schaltest du `kiro.dev` und
   `agentclientprotocol.com` in den Umgebungseinstellungen frei, dann lese ich die Doku selbst.
2. ~~Freigabe für Phase 1.~~ Erteilt (2026-10-23, „Du hast mein Go“).
3. **Publisher-ID und Name für die Copyright-Zeile.** `package.json` braucht einen `publisher`; für die Apache-Lizenz lege ich
   eine `NOTICE`-Datei mit dem Copyright-Inhaber an, sobald ich den Namen kenne. Soll das Repo öffentlich sein?
4. **Beispiel-Spec** (E3): erst in Phase 4.

## 8. Probe ausführen

Voraussetzungen: Node 20+, installierte und angemeldete Kiro CLI (`kiro-cli whoami`). Wer die Probe schon einmal gestartet
hat, holt zuerst den neuen Stand: `git pull` und `npm ci`.

```bash
git clone -b claude/dreamy-curie-tne5sj https://github.com/lldeters/kiro-studio.git && cd kiro-studio
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
| A2 | Im Autopilot sind nur Rückfragen mit `askType: "implicit"` automatisch zu erlauben. | Andere Werte werden dir gezeigt, nicht automatisch erlaubt (sicherer Standard). Du kannst die Auslegung E1 erweitern lassen. |
| A3 | Die CLI beendet sich nach geschlossenem stdin nicht zuverlässig. | Nach 5 s Gnadenfrist wird der Prozessbaum beendet. Beendet sie sich doch, passiert nichts weiter. |
| A4 | Abgemeldet bedeutet: `whoami` endet mit Fehler oder liefert kein JSON in der ersten Zeile. | Im schlimmsten Fall steht „bereit“ oder „nicht angemeldet“ im falschen Zustand; die Statusanzeige und „Einrichtung prüfen“ zeigen den Fehler dann beim ersten Verbinden. |
| A5 | `terminal` bleibt abgeschaltet; Hooks laufen nur mit Opt-in. Der Hook-Verkehr nach dem Opt-in ist nicht beobachtet. | Hook-Nachrichten werden ignoriert, solange kein Code sie auswertet (Phase 3). |
| A6 | Der Host-Code (Statusleiste, Befehle, Dialoge) ist nur typgeprüft und durch die Integrationstests in der CI abgedeckt, nicht von mir in einem echten VS Code gesehen. | Darstellungsfehler sind möglich, siehe unten „Abnahme bei dir“. |

### Voreinstellungen, die ich gewählt habe

- `kiroStudio.autonomy`: **supervised** (nicht Autopilot). Neue Sessions fragen also nach.
- `kiroStudio.autoAllowInAutopilot`: **an**, wirkt aber nur im Autopilot und nur für `allow_once` (Entscheidung E1). Die Einstellung gilt
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

