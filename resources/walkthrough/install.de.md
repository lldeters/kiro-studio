# Kiro-CLI installieren

Kiro Studio bringt keinen eigenen Agenten mit. Es spricht mit der **Kiro-CLI**, die auf deinem Rechner installiert ist,
und zeigt in VS Code, was die CLI tut.

1. Folge der Installationsanleitung: <https://kiro.dev/docs/cli/>
2. Öffne ein neues Terminal und führe `kiro-cli --version` aus.
3. Findet VS Code das Programm nicht (Editoren erben den `PATH` deiner Shell oft nicht), führe
   **Kiro Studio: Pfad der Kiro CLI festlegen** aus und wähle die ausführbare Datei. Unter Windows ist das meist
   `%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe`.

Kiro Studio ist ein unabhängiges Projekt und steht in keiner Verbindung zu AWS oder Kiro.
