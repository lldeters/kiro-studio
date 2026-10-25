# Veröffentlichen

Wie Kiro Studio in den Visual Studio Marketplace (und auf Wunsch nach Open VSX) kommt: was einmal einzurichten ist, was
vor dem ersten Release mit der echten Kiro CLI zu prüfen ist, und wie ein Release dann abläuft. Das meiste macht der
Workflow [`.github/workflows/release.yml`](../.github/workflows/release.yml); einige Schritte gehen nur mit deinen Konten.

**Kurz:** einmal Publisher und Anmeldung einrichten (Abschnitt 1), die Abnahme machen (2), entscheiden (3), dann
`npm run release:prepare -- 0.1.0`, committen, `git tag v0.1.0`, Tag pushen (4).

## 1. Einmal einrichten

### 1.1 Repository

1. **`main` zum Standard-Branch machen.** `main` gibt es schon; alle Arbeit geht von ihm aus und wird per Pull Request
   dorthin gemergt. Auf GitHub: *Settings → General → Default branch*, die Pfeile neben dem Branch, `main` wählen,
   *Update*. Danach kann der alte Standard-Branch `claude/dreamy-curie-tne5sj` gelöscht werden (*Branches*, Papierkorb);
   er hat denselben Stand wie `main` vor dem ersten Merge. Die Bilder und Links im README auf dem Marketplace zeigen auf
   den Standard-Branch (`…/raw/HEAD/…`), er muss also den veröffentlichten Stand haben; der Probelauf des Release-Workflows
   lässt sich erst starten, wenn der Workflow dort liegt.
2. **Den offenen Pull Request nach `main` mergen** (Code-Review-Fixes und diese Vorbereitung), wenn die CI grün ist.
   Optional unter *Settings → Branches* eine Regel für `main` anlegen: Änderungen nur per Pull Request, und die Checks der
   CI müssen grün sein.
3. **Private Meldungen von Sicherheitslücken einschalten** (`SECURITY.md` verweist darauf): *Settings → Advanced
   Security* (oder *Code security*) *→ Private vulnerability reporting → Enable*.
4. Optional: unter *Settings → Environments → release* eine Schutzregel setzen (*Required reviewers*: du). Dann wartet
   jeder Release auf deinen Klick, bevor er etwas veröffentlicht. Die Umgebung legt der erste Lauf des Workflows an.

### 1.2 Publisher im Marketplace

1. Auf <https://marketplace.visualstudio.com/manage> mit einem Microsoft-Konto anmelden, *Create publisher*.
2. **ID: `lldeters`**, so steht es in `package.json` (`publisher`). Ist die ID vergeben, eine andere wählen und `publisher`
   in `package.json` ändern (die Erweiterung heißt dann `<id>.kiro-studio`). Der Name ist der Anzeigename.

### 1.3 Anmeldung des Workflows beim Marketplace

Der Workflow nimmt den ersten Weg, der eingerichtet ist: Entra ID, dann Trusted Publishing, dann ein Token.

**Wichtig:** Azure DevOps nimmt Tokens für *All accessible organizations* ab dem **1. Dezember 2026** nicht mehr an.
Microsofts Anleitung nennt diese Einstellung noch, empfiehlt aber Microsoft Entra ID. Für den Marketplace selbst ist
Trusted Publishing (wie bei npm) angekündigt, aber noch nicht freigegeben.

**A) Token (am schnellsten, für den ersten Release)**

1. <https://dev.azure.com> öffnen (beim ersten Mal eine Organisation anlegen, der Name ist egal).
2. *User settings* (Zahnrad oben rechts) *→ Personal access tokens → New Token*:
   - *Organization*: **deine Organisation**, nicht *All accessible organizations*;
   - *Scopes*: *Custom defined → Show all scopes → Marketplace → Manage*;
   - Ablaufdatum nach Wunsch (höchstens ein Jahr).
3. Prüfen: `npx vsce verify-pat lldeters` und das Token eingeben. Meldet es 401/403, ein Token mit *All accessible
   organizations* nehmen (geht bis 30.11.2026) und später auf B umsteigen.
4. Auf GitHub: *Settings → Secrets and variables → Actions → New repository secret*, Name `VSCE_PAT`, Wert das Token.

**B) Microsoft Entra ID (ohne Token, von Microsoft empfohlen)**

1. Im Azure-Portal: *Microsoft Entra ID → App registrations → New registration*, Name z. B. `kiro-studio-publish`, ohne
   Redirect-URI. Auf der Übersicht *Application (client) ID* und *Directory (tenant) ID* notieren.
2. *Certificates & secrets → Federated credentials → Add credential*, Szenario *GitHub Actions deploying Azure resources*:
   Organization `lldeters`, Repository `kiro-studio`, Entity type **Environment**, Name **`release`**.
3. Auf GitHub unter *Settings → Secrets and variables → Actions → Variables* (Variablen, keine Secrets):
   `AZURE_CLIENT_ID` und `AZURE_TENANT_ID` mit den beiden IDs.
4. *Actions → Release → Run workflow*, Häkchen **whoami** setzen. Der Lauf gibt die *Marketplace member ID* der Identität
   aus (Abschnitt *Annotations*).
5. Auf <https://marketplace.visualstudio.com/manage> den Publisher öffnen, *Members → Add*, die ID eintragen, Rolle
   **Contributor**.
6. Falls vorher ein `VSCE_PAT` eingerichtet war: das Secret löschen und das Token in Azure DevOps widerrufen (Löschen des
   Secrets allein widerruft es nicht).

**C) Trusted Publishing des Marketplace (sobald Microsoft es freigibt)**

Der Workflow ist vorbereitet: Repository-Variable `MARKETPLACE_TRUSTED` auf `true` setzen. Er ruft dann `vsce publish
--oidc` auf. Ungetestet, weil es die Gegenseite noch nicht gibt; die Einrichtung im Marketplace (Repository, Workflow
`release.yml`, Umgebung `release`) beschreibt Microsoft dann in der Anleitung zum Veröffentlichen.

### 1.4 Open VSX (optional)

Open VSX ist der Marktplatz von VSCodium, Cursor, Windsurf, Gitpod und anderen Editoren ohne Microsofts Marketplace.

1. Auf <https://open-vsx.org> mit GitHub anmelden, unter *Settings* ein Eclipse-Konto verknüpfen und das *Publisher
   Agreement* unterschreiben.
2. *Settings → Access Tokens → Generate New Token*.
3. Den Namespace anlegen: `npx ovsx create-namespace lldeters -p <token>`. Er gehört damit noch nicht exklusiv dir; das
   beantragt man bei Open VSX getrennt, siehe [Publishing Extensions](https://github.com/eclipse/openvsx/wiki/Publishing-Extensions).
4. Auf GitHub das Secret `OVSX_PAT` anlegen. Oder ohne Token: im Namespace einen *Trusted Publisher* eintragen
   (Repository `lldeters/kiro-studio`, Workflow `release.yml`, Umgebung `release`) und die Variable `OPEN_VSX_TRUSTED` auf
   `true` setzen.

Ohne beides lässt der Workflow Open VSX mit einem Hinweis aus.

## 2. Abnahme mit der echten Kiro CLI (vor dem ersten Release)

Bisher ist alles gegen eine nachgebaute CLI getestet, in der CI auf Windows, macOS und Linux; die echte CLI kennt nur der
Probe-Lauf. Die folgenden Punkte bestätigen die Annahmen in [PLAN.md](PLAN.md) (Abschnitte 9 bis 13, A1 bis A24) und die
Fixes aus dem Code-Review. Am besten auf deinem Windows-Rechner, mit einem kleinen Test-Repository.

**Vorbereiten:** `npm ci`, `npm run package`, `code --install-extension dist/kiro-studio.vsix`, VS Code neu laden, einen
Ordner öffnen (vertrauen). In der Statusleiste steht *Kiro* mit Häkchen.

**Chat und Freigaben**

- [ ] Neue Sitzung (**+**), ein kleiner Auftrag („Lege hello.txt mit einem Gruß an“). Bis etwas kommt, steht im Chat
      „Kiro denkt nach …“; dann streamt die Antwort. In der Eingabebox stehen Agent und Modell, darunter **Supervised**.
- [ ] Ein Modell mit Aufwand wählen (Aufwand *high*) und etwas Kniffliges fragen. Wenn Kiro Denkschritte sendet, erscheinen
      sie aufgeklappt unter „Denkt nach …“ und klappen nach der Antwort zu „Gedankengang“ zu. Kommen keine, sendet die
      CLI sie nicht (`agent_thought_chunk` war in keiner Aufzeichnung); das bitte melden.
- [ ] Die Freigabe-Frage zeigt den Diff; *Allow once* → die Karte „Kiro hat eine Datei geändert“ erscheint.
- [ ] *Änderungen ansehen* öffnet den Diff, *Zurücknehmen* fragt und entfernt die Datei wieder.
- [ ] Eine Datei mit Windows-Zeilenenden (CRLF) von Kiro ändern lassen und zurücknehmen: kein Hinweis „seit dem Turn
      geändert“ (Fix aus dem Review).
- [ ] Unter der Eingabebox auf **Autopilot** schalten, Auftrag geben: keine Frage, im Chat steht „Automatically allowed
      once“.
- [ ] Zurück auf Supervised; der Knopf unter der Box und *Kiro Studio: Switch Between Supervised and Autopilot* schalten
      immer in die angezeigte Richtung.
- [ ] Chat ausblenden, während Kiro zwei Dinge fragt: Nach der ersten Antwort im Auswahlfenster öffnet sich die zweite Frage
      von selbst (Fix aus dem Review).
- [ ] `#` und `/` in der Eingabe, ein Bild einfügen, `#git diff` anhängen.

**Sitzungen und Verbindung**

- [ ] In *Sitzungen* eine frühere Sitzung öffnen: die Unterhaltung erscheint einmal (auch bei Doppelklick), unter der
      Eingabebox steht **Supervised**, auch wenn die Sitzung früher in Autopilot lief (Fix aus dem Review).
- [ ] *Kiro Studio: Restart Agent Connection*: die Sitzungen kommen zurück, die Checkpoint-Karten auch.
- [ ] Im Task-Manager den `kiro-cli`-Prozess beenden: der Chat sagt, dass die Verbindung weg ist, und stellt sie wieder her.
- [ ] VS Code schließen: danach läuft kein `kiro-cli` mehr (Task-Manager). Annahme A3.

**Kiro-Panel und Specs**

- [ ] Steering: neue Datei, *Kiro schreiben lassen* (Kiro legt `product.md`, `tech.md`, `structure.md` an).
- [ ] MCP: Server hinzufügen (auch mit einem Pfad mit Leerzeichen in Anführungszeichen), einschalten, neue Sitzung, Status.
- [ ] Hooks: die Ansicht bietet den Schalter an; erst nach dem Einschalten laufen sie.
- [ ] *Neue Spec* (Anforderungen zuerst): Kiro schreibt `requirements.md` und hält an; in der Spec-Ansicht *Freigeben und
      weitermachen* → `design.md` mit gezeichneten Diagrammen → `tasks.md`.
- [ ] In `tasks.md` *Aufgabe starten*: Kiro erledigt sie und kreuzt sie an, der Fortschritt folgt.
- [ ] **Schick mir die `tasks.md`** (gern mit `requirements.md` und `design.md`): damit prüfe ich das Format (A19).

**Darstellung**

- [ ] Hochkontrast-Theme (Umrisse, Fokusrahmen), VS Code auf Deutsch (Oberfläche und Einführung deutsch, A23),
      optional ein Screenreader (eine Frage wird sofort vorgelesen).

**Probe-Läufe** (Abschnitt 8 in PLAN.md), schließen offene Annahmen:

- [ ] `npm run probe -- --review reject` (A1, A12), `npm run probe -- --autopilot on` (A2),
      `npm run probe -- --exit-wait 30 --no-prompt` (A3). Mir `summary.json` und `wire.ndjson` schicken (vorher durchsehen).

**Danach:** Was nicht stimmt, schick mir mit dem Protokoll (*Kiro Studio: Show Protocol Log*). Wenn alles passt, im README
den Hinweis *Preview* oben und den ersten Punkt unter *Known limits* anpassen (oder mir Bescheid geben).

## 3. Vor dem ersten Release entscheiden

- **Name und Marke.** „Kiro“ ist eine Marke ihres Inhabers (AWS). README und Beschreibung sagen deutlich, dass Kiro Studio
  inoffiziell ist und keine Kiro-Logos enthält. Der Name „Kiro Studio“ kann trotzdem nach einem offiziellen Produkt aussehen,
  und ein Markeninhaber kann beim Marketplace verlangen, dass eine Erweiterung entfernt oder umbenannt wird. Möglich: so
  lassen, vorher bei Kiro nachfragen, oder umbenennen (etwa „Studio for Kiro CLI“). Das ist keine Rechtsberatung.
  Eine Umbenennung übernehme ich, sie betrifft Anzeigename, Texte und Screenshots, nicht die ID.
- **Vorschau.** `"preview": true` zeigt im Marketplace „Preview“. Für 0.1.0 passend; für 1.0 entfernen.
- **Open VSX** ja oder nein (Abschnitt 1.4).

## 4. Ein Release veröffentlichen

1. Auf dem Standard-Branch, aktueller Stand, CI grün.
2. `npm run release:prepare -- 0.1.0`. Das setzt die Version in `package.json` und `package-lock.json` und das Datum im
   Abschnitt `## [0.1.0]` von `CHANGELOG.md` (heute, oder `--date YYYY-MM-DD`), und prüft alles.
3. Den Diff ansehen, committen (`chore(release): 0.1.0`), pushen, CI abwarten.
4. Optional ein Probelauf: *Actions → Release → Run workflow*. Er baut und prüft alles und lädt das `.vsix` als Artefakt
   hoch, veröffentlicht aber nichts.
5. `git tag v0.1.0 && git push origin v0.1.0`. Der Workflow prüft Tag, Version und Changelog, testet, baut, veröffentlicht
   im Marketplace (und bei Open VSX) und legt das GitHub-Release mit dem `.vsix` und dem Changelog-Abschnitt an.
6. Nachsehen: <https://marketplace.visualstudio.com/items?itemName=lldeters.kiro-studio> (der Marketplace prüft das Paket
   erst, das dauert einige Minuten), bei Open VSX <https://open-vsx.org/extension/lldeters/kiro-studio>, und das Release auf
   GitHub. In VS Code: Erweiterungen, „Kiro Studio“ suchen.
7. Für die nächste Version oben im Changelog einen Abschnitt `## [Unreleased]` anlegen; `release:prepare` macht daraus
   die neue Version.

Die CI prüft bei jedem Push, dass Version und Changelog zu einem Release passen (nur das Datum darf fehlen).

## 5. Wenn etwas schiefgeht

- **Der Workflow scheitert, bevor er veröffentlicht** (Prüfung, Tests, Paket): beheben, den Tag löschen
  (`git push --delete origin v0.1.0 && git tag -d v0.1.0`) und neu setzen.
- **Er scheitert danach** (zum Beispiel bei Open VSX): den Lauf wiederholen (*Re-run jobs*). Was schon veröffentlicht ist,
  wird übersprungen.
- **Eine Version ist kaputt:** eine neue Version mit dem Fix veröffentlichen. `npx vsce unpublish` entfernt die ganze
  Erweiterung mit allen Versionen und ihren Bewertungen.
- **Token abgelaufen** (401/403 im Schritt *Publish*): ein neues anlegen (1.3 A) und das Secret ersetzen, oder auf Entra ID
  umsteigen (1.3 B).
