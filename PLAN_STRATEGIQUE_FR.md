# Document de Conception et Plan Stratégique : Projet "Next-Gen IDE"

Pour détrôner un outil hégémonique comme Visual Studio Code (plus de 70 % de parts de marché), copier son modèle est voué à l'échec. La bascule ne s'opère que si l'on identifie les failles structurelles des solutions existantes et que l'on exploite une rupture d'usage que l'architecture actuelle ne peut pas encaisser.

---

## 1. La faille critique (le "talon d'Achille") du marché actuel

Chaque environnement actuel souffre d'un compromis technique majeur qui frustre ses utilisateurs :

| IDE / Éditeur | Architecture | Problème critique & Limite bloquante |
| :--- | :--- | :--- |
| **VS Code** | Electron / Node.js | **Dette technique & IA greffée en surface** : Consommation RAM excessive, latence d'affichage. Son architecture a été conçue pour afficher des fichiers plats, pas pour orchestrer des agents d'IA autonomes. |
| **Cursor** | Fork Electron de VS Code | **Boîte noire & fuite de données** : Modèle opaque qui achemine le code vers des infrastructures tierces (risques légaux majeurs en entreprise), coût récurrent élevé. |
| **Zed** | Natif Rust / GPU | **Écosystème famélique** : Vitesse fulgurante, mais catalogue d'extensions quasi vide. Impossible de l'adopter pour des stacks techniques de niche. |
| **JetBrains** | Monolithe Java / JVM | **Lenteur d'indexation & rigidité** : Monstre de consommation mémoire (souvent 8 à 16 Go de RAM), démarrages interminables, coût de licence prohibitif. |
| **Neovim** | C / Lua (Terminal) | **La « taxe de configuration »** : Demande des dizaines d'heures de réglages individuels en scripts Lua. Impossible à standardiser dans une équipe classique. |
| **Eclipse Theia**| TypeScript / Web | **Complexité d'intégration** : Ce n'est pas un IDE prêt à l'emploi, mais un framework nécessitant des mois d'ingénierie interne pour le rendre utilisable. |

*Pourquoi personne n'arrive à détrôner VS Code en frontal ?* À cause de l'effet de réseau de ses 30 000+ extensions, de sa gratuité (financée à perte par Microsoft), et de la force de l'habitude. Il faut donc changer le paradigme.

---

## 2. Les 3 Pistes de Rupture (Axes d'Innovation)

Pour contourner la forteresse de Microsoft, il faut redéfinir l'environnement de développement à l'ère de l'IA.

### Axe A : Le Cockpit d'Orchestration d'Agents (L'après-éditeur)
Le développeur ne tape plus le code d'infrastructure. Il formule des intentions, définit des contraintes et supervise des agents d'IA travaillant en parallèle.
* **Le produit** : Un IDE centré sur un **tableau de bord de validation d'exécution** plutôt que sur une arborescence de fichiers.
* **L'innovation clé** : Intégration de micro-bacs à sable (sandboxes) éphémères. L'agent génère le code, compile, teste, et présente un résumé : *"Voici le diff, les tests passent, validez-vous ?"* L'humain n'intervient que pour l'arbitrage.

### Axe B : L'IDE "Zero-Trust & Local-First" pour Entreprises
Cursor est interdit dans les banques ou le milieu médical car il envoie le code sur des serveurs externes.
* **Le produit** : Le pendant open-source, sécurisé et souverain de Cursor.
* **L'innovation clé** : Intégration du protocole **MCP (Model Context Protocol)** avec une isolation locale absolue. L'IDE se branche sur des modèles open-source exécutés en local (GPU) ou sur les serveurs privés de l'entreprise (SSO/Entra ID) avec zéro fuite de code.

### Axe C : Le "Cheval de Troie" (Moteur Rust + Émulateur VS Code)
* **Le produit** : Un éditeur natif à vitesse instantanée (comme Zed), doté d'une **couche de compatibilité (runtime WASM/V8)** pour exécuter les extensions VS Code.
* **L'innovation clé** : Zéro coût de migration. L'utilisateur importe sa configuration VS Code en un clic, retrouve ses extensions, mais bénéficie d'une vitesse 10x supérieure et d'une empreinte RAM divisée par 5.

### Matrice comparative des approches

| Critère | Axe 1 : Cockpit d'Agents | Axe 2 : IDE Local-First | Axe 3 : Moteur Rust + Émulateur |
| :--- | :--- | :--- | :--- |
| **Cible** | Développeurs & Startups | Grandes entreprises réglementées | L'ensemble des utilisateurs VS Code |
| **Complexité** | Moyenne (Sandboxing) | Moyenne-Haute (Protocoles IA/Sécurité) | Très Haute (Reverse-engineering API) |
| **Rupture** | Change la façon de coder | Débloque les budgets B2B | Élimine la barrière de migration |

---

## 3. Plan d'Action Opérationnel (Pour le Binôme)

### 3.1. Cadrage et Arbitrage Fondateur (Semaines 1 à 2)
* **Sélection de l'axe de rupture** : Choisir un seul des 3 axes ci-dessus pour le MVP (Minimum Viable Product).
* **Rédaction du Manifeste Produit** : Définir ce que l'utilisateur peut accomplir en 3 clics qu'il ne peut pas faire sur VS Code. Définir ce que le produit **ne fera pas** au lancement.
* **Audit des briques logicielles** :
  * Éditeur embarqué : Monaco Editor vs CodeMirror 6.
  * Framework desktop : Tauri v2 (Rust + Webview) vs Electron.
  * Moteur d'exécution : Docker Engine local, WebContainers, ou micro-VMs.

### 3.2. Architecture Technique Cible du MVP (Semaines 3 à 4)
L'architecture repose sur un découplage strict :

```text
┌─────────────────────────────────────────────────────────────┐
│                    Interface Utilisateur (UI)               │
│  Tauri v2 + React / Svelte + Monaco Editor (ou CodeMirror)  │
└──────────────┬──────────────────────────────┬───────────────┘
               │ (IPC / WebSocket)            │ (Events)
┌──────────────▼──────────────┐ ┌─────────────▼───────────────┐
│     Orchestrateur Local     │ │    Protocole Contexte & IA  │
│        (Core en Rust)       │ │     Client MCP Standard     │
└──────────────┬──────────────┘ └─────────────┬───────────────┘
               │                              │
┌──────────────▼──────────────────────────────▼───────────────┐
│              Bac à Sable Isolé (Sandbox Locale)             │
│     - Cloner le dépôt Git / Exécuter les tests              │
│     - Serveur de prévisualisation web                       │
└─────────────────────────────────────────────────────────────┘
```

### 3.3. Matrice de Répartition des Rôles

| Domaine de Responsabilité | Profil A (ex: Produit & Frontend) | Profil B (ex: Systèmes & IA) |
| :--- | :--- | :--- |
| **Interface & Ergonomie** | Conception UI (Tauri, React), intégration Monaco. | Mise en place de l'IPC (Rust-UI). |
| **Moteur d'Agents & IA** | Définition des flux et prompts système. | Intégration MCP, gestion des contextes. |
| **Exécution & Système** | Affichage des logs et terminaux web. | Orchestration conteneurs, isolation système. |
| **Validation Marché** | Entretiens utilisateurs, recueil des retours. | Veille sécurité, benchmarks performance. |

### 3.4. Feuille de Route (Mois 1 à 6)

* **Mois 1-2 (Preuve de Concept - PoC)** : Application de bureau minimaliste. L'utilisateur tape un prompt ("Ajoute un endpoint"), un agent modifie les fichiers en local, lance le test et affiche le résultat (vert/rouge) avec 0 modification manuelle requise.
* **Mois 3-4 (MVP)** : Version stable sur un langage unique (ex: TypeScript). Intégration d'un visualiseur de "Diff" pour valider/rejeter le code de l'IA, et support des serveurs MCP. Vous devez coder l'outil en utilisant l'outil lui-même.
* **Mois 5 (Alpha Fermée)** : Test avec 15 à 20 développeurs du réseau. Observation des blocages et mesure du taux de rétention.
* **Mois 6 (Lancement)** : Publication Open-Source (licence permissive), distribution binaire signée (macOS, Windows, Linux), et campagne de lancement (Article technique, Product Hunt, Hacker News).

### 3.5. Pièges Critiques à Éviter (Anti-Patterns)
1. **La réécriture totale** : Ne réécrivez pas un éditeur de texte ou un terminal. Utilisez des briques éprouvées (Monaco, Xterm.js).
2. **La dispersion multi-langages** : Supportez parfaitement une seule stack (ex: écosystème web TypeScript) avant d'ajouter le support de Python ou Go.
3. **Le modèle d'abonnement immédiat** : Laissez l'utilisateur brancher ses propres clés API (BYOK) ou son modèle local (Ollama) pour éviter les coûts d'infrastructure de votre côté au démarrage.