# TextMachine pour Obsidian

Dans **Réglages → TextMachine**, saisissez votre adresse Gmail et cliquez sur **Connecter**. Google ouvre la connexion dans votre navigateur et vous demande d’autoriser la lecture et la modification des messages. De retour dans Obsidian, choisissez le **Libellé source**. **Vérifier l’accès** confirme son existence et affiche le nombre de messages.

Les réglages affichent **Connecter** ou **Déconnecter**, selon la session. Sans connexion, les autres contrôles sont désactivés. L’extraction se lance depuis le menu contextuel du dossier : **Text Machine** propose la reconnexion si nécessaire. Sans dossier de données configuré, cette commande est disponible sur les dossiers du coffre et propose d’en créer un avant de poursuivre.

Votre mot de passe est saisi uniquement chez Google. Le plugin conserve l’adresse du compte et le jeton de renouvellement dans le coffre de secrets local d’Obsidian. Le jeton d’accès reste en mémoire. `data.json` contient uniquement le nom du secret et l’identifiant du libellé et le dossier des données. **Déconnecter** révoque l’autorisation Google et retire la session locale.

Google autorise la lecture et la modification des messages du compte entier ; le libellé sélectionné définit la source de TextMachine. Dans **Choisir le dossier où enregistrer les données**, **Créer le dossier** est obligatoire avant l’extraction. Créez un dossier (`TextMachine` par défaut) ou sélectionnez un dossier existant vide. `textmachine.json` est créé avec une liste d’articles vide, puis un clic droit sur ce dossier → **Text Machine** traite les messages non lus du libellé sélectionné. Chaque message traité est marqué comme lu après une écriture réussie du JSON, même si ses liens sont exclus ou déjà présents. Une erreur d’extraction ou d’écriture laisse le message non lu. Si le marquage Gmail échoue, les articles restent enregistrés et une relance reprend sans doublon. Les identifiants des messages sont collectés avant tout marquage pour éviter de sauter des pages. Aucune donnée n’est reprise des anciens fichiers `log.md`, qui ne sont ni lus ni modifiés.

Le fichier contient un objet `{ "version": 1, "articles": [] }`. Chaque article possède les champs `date`, `title`, `url`, `source`, `status`, `publish`, `content` et `image`. `status` est une chaîne vide après une extraction réussie et vaut `"404"` lorsque le contenu est inaccessible. Les anciennes valeurs de `used` sont conservées dans `status` lors de la prochaine écriture. `publish` contient la date de publication fournie par le site, `content` le texte de l’article et `image` l’URL de son image principale. La date est recherchée dans les métadonnées, les données structurées et les balises de date visibles en français ou anglais. La date du mail et la date de modification ne servent pas de remplacement. Lors d’une nouvelle extraction, les articles ayant déjà du texte mais aucune date sont réinterrogés sans écraser leur contenu. Une date absente reste vide. Les champs supplémentaires ajoutés à la racine ou aux articles sont conservés lors des extractions. Une nouvelle extraction enrichit le fichier sans écraser les statuts ou annotations existants. Les doublons sont éliminés par URL ou titre ; la comparaison des titres ignore la casse, les accents et la ponctuation. Un JSON invalide ou d’une version inconnue bloque l’extraction sans être remplacé.

Google Alerts et Google Scholar sont reconnus par leur adresse d’expédition ; les catégories utilisateur et autre service sont présumées à partir des en-têtes. Les liens de gestion Google (y compris `google.fr`), de navigation, de désabonnement, de réseaux sociaux, de vidéo et d’applications sont exclus. Les redirections Google sont décodées. Si le message contient des liens HTML, la version texte n’est pas retraitée. Après l’enregistrement des liens et leur marquage Gmail comme lus, les pages cibles sont chargées dans une fenêtre Chromium isolée et invisible, fournie par Obsidian. JavaScript peut rendre la page ; la fenêtre se ferme ensuite automatiquement. Les pages n’ont accès ni à Node.js, ni au coffre, ni aux sessions du navigateur habituel. Les adresses locales sont refusées. Les captchas et les accès abonnés ne sont pas contournés. Aucun contenu HTML du message n’est exécuté.

**Sources exclues** accepte un domaine, un mot de domaine ou un nom de source comme `Google Alerts`, par ligne. `youtube` exclut `youtube.com`, `youtube.be`, `youtu.be` et leurs sous-domaines ; un domaine complet comme `example.com` reste limité à ce domaine et ses sous-domaines. Les exclusions s’enregistrent automatiquement et filtrent les prochaines extractions sans retirer les articles déjà présents. **Réinitialiser le JSON** demande confirmation, puis remet le fichier à `{ "version": 1, "articles": [] }`. Les articles, statuts et champs supplémentaires du fichier sont supprimés ; les réglages Gmail et exclusions restent en place.

Les anciennes connexions en lecture seule doivent être renouvelées avec **Connecter** pour autoriser le marquage comme lu. Réinitialiser le JSON ne remet pas les messages Gmail à l’état non lu.

Les refus d’accès des sites sont enregistrés dans `blocked.json`, dans le dossier des données. Seuls les domaines sont stockés dans une liste, par exemple `["thetimes.com"]` ; les sous-domaines sont regroupés et ne sont plus interrogés non plus. La [Public Suffix List](https://publicsuffix.org/list/) embarquée (`scripts/vendor/public_suffix_list.dat`, licence MPL 2.0 incluse) distingue notamment les domaines comme `bbc.co.uk`. Les anciennes entrées détaillées sont simplifiées lors du prochain traitement. Les entrées mémorisées ne sont plus interrogées, y compris après réinitialisation de `textmachine.json`. **Voir blocked.json** permet de les consulter dans les réglages. Un fichier de blocage invalide arrête le traitement au lieu d’ignorer ses exclusions.

## Intelligence artificielle

Les réglages reprennent les choix de Finition : clés Anthropic et OpenAI, serveur et modèle locaux, Codex et modèle par défaut ou personnalisé. Le catalogue initial des modèles est repris de `plugin/ai/models.json` (copié de Finition). Codex choisi explicitement est prioritaire ; sinon un serveur local renseigné est prioritaire sur les API cloud. Un serveur local mal configuré produit une erreur sans repli automatique vers le cloud. Les clés se choisissent ou se créent avec le sélecteur natif des secrets d’Obsidian ; elles peuvent être partagées avec d’autres plugins. Text Machine conserve uniquement les identifiants sélectionnés (`anthropicSecretId` et `openaiSecretId`) dans `data.json`. Les clés précédemment saisies dans Text Machine restent disponibles et leur référence est reprise automatiquement.

Codex est détecté aux mêmes emplacements que dans Finition. La liste de ses modèles est lue avec `app-server` (`account/read` puis `model/list`) ; aucune génération n’est lancée et sa configuration n’est pas modifiée. L’arrêt du plugin annule une lecture en cours. La connexion au compte se fait avec Codex CLI. Les réglages IA restent disponibles sans connexion Gmail.

Le dossier `prompts/` est réservé aux futurs prompts de fabrication des newsletters. Cette étape prépare la configuration IA ; aucune commande de génération de newsletter n’est encore ajoutée.

## Langue

L’interface suit la langue d’Obsidian : français (`locales/fr.json`) ou anglais (`locales/en.json`). Les variantes régionales, comme `fr-CA`, utilisent leur langue de base ; les autres langues utilisent l’anglais. Réactivez le plugin après un changement de langue. Les réglages, erreurs, messages de connexion et libellés de source sont traduits. Les noms de dossiers restent inchangés. Les catalogues utilisent des clés communes et des paramètres nommés, comme Bookbinder.

## Installation et configuration de la distribution

Obsidian 1.11.4 ou plus récent sur ordinateur est nécessaire. Le build utilise directement l’entrée TypeScript `plugin/main.ts`. Les modules internes sont regroupés dans `plugin/`. Le build inclut les traductions, le catalogue IA, Readability et la Public Suffix List dans `main.js`. Les trois fichiers installables sont `main.js`, `manifest.json` et `styles.css` ; `main.js` est généré et exclu de Git.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Readability 0.6.0 provient de [Mozilla](https://github.com/mozilla/readability/tree/0.6.0), avec sa licence Apache 2.0 dans `scripts/vendor/readability/`. `npm run dev` reconstruit le plugin à chaque modification des sources.

`./release.sh` suit la procédure de Finition : découverte du dépôt et de sa branche par défaut, préparation des ressources publiques, vérifications TypeScript, lint, build, commit et push des changements, première publication du tag `0.0.1`, puis incrément du patch dans manifest/package/lock/versions pour les suivantes, nouveau push, comparaison du manifest distant, puis création et push du tag. Aucun fichier `main.js` local n’est téléversé.

Pour la toute première publication `0.0.1`, tant qu’aucune release n’existe, `release.sh` détecte aussi l’historique divergent ou les fichiers ignorés encore suivis et exécute la remise à zéro déjà demandée. Il garde les fichiers locaux, reste sur `main`, aligne le distant sur un commit initial propre, retire les anciens tags puis publie `0.0.1`. Après une release publiée, ce nettoyage destructif ne se déclenche plus automatiquement.

Le tag lance `.github/workflows/release.yml` : installation par `npm ci`, contrôle des versions, vérifications et tests, double build avec comparaison SHA-256, contrôle de la taille, attestation de provenance, publication des ressources publiques dans une prerelease `resources-<version>` puis des trois fichiers du plugin dans la release `<version>`. Les prompts et les licences sont inclus dans le catalogue de ressources avec tailles et empreintes ; ni `oauth-client.json`, ni `data.json`, ni les environnements ou caches locaux ne sont publiés.

`npm run test:release` vérifie les scénarios de publication avec des dépôts temporaires et un faux client GitHub, sans publication réelle.

La connexion Gmail utilise une configuration locale de client OAuth Google pour ordinateur dans `oauth-client.json`, au format JSON `installed` fourni par Google. Ce fichier local reste exclu du dépôt et des releases publiques. Sans client OAuth configuré, les réglages indiquent que la connexion Google n’est pas encore disponible ; aucune connexion factice n’est présentée comme réussie.

Le mainteneur active Gmail API, configure l’écran de consentement et l’autorisation `https://www.googleapis.com/auth/gmail.modify`, puis crée le client OAuth de bureau. Pendant les tests, les comptes autorisés doivent figurer dans les utilisateurs tests. La diffusion publique est soumise aux exigences Google de validation des accès Gmail. Voir le [parcours OAuth pour ordinateur](https://developers.google.com/identity/protocols/oauth2/native-app) et les [autorisations Gmail](https://developers.google.com/workspace/gmail/api/auth/scopes).

Le retour OAuth utilise un serveur temporaire sur `127.0.0.1`, PKCE et une valeur `state` aléatoire. Le serveur ferme après réception de l’autorisation, annulation, désactivation du plugin ou expiration de trois minutes. L’adresse saisie est transmise à Google comme indication de compte ; l’identité finale est celle confirmée par Gmail.

## Vérification

```sh
npm test
npm run check
```

Sur macOS, `venv/bin/python -B scripts/tests/settings_ui.py` vérifie les réglages dans une instance isolée d’Obsidian avec Playwright : compte déconnecté, choix du libellé, enregistrement, résultat et erreur, choix du dossier, extraction HTML, reprise après interruption et absence de doublons.

`venv/bin/python -B scripts/tests/crawler_ui.py` vérifie le rendu JavaScript dans Chromium, l’extraction Readability, les métadonnées et l’isolation avec des pages simulées.

Les tests simulent les réponses Google. La connexion réelle exige un client OAuth actif et le consentement du titulaire du compte.

Les scripts Python restent disponibles pour le traitement RSS et Substack ; ils ne sont pas encore pilotés depuis le plugin. L’ancien workflow de conversion des issues est supprimé ; seule la publication du plugin sur tag reste automatisée.

Les tests sont regroupés dans `scripts/tests/`, les bibliothèques tierces dans `scripts/vendor/`. Les outils de développement sont dans `scripts/`, les sources du plugin dans `plugin/`. Les lanceurs `release.sh`, `git.sh` et `subs.sh` restent à la racine. `_doc.md` reste local et ignoré par Git.

Pour repartir volontairement d’un historique neuf : `bash scripts/reset-github.sh`. Le script reste sur `main`, conserve les fichiers locaux ignorés, prépare un seul commit initial sans ces fichiers et remplace atomiquement le `main` distant en retirant les anciens tags. La branche locale est alignée uniquement après réussite de l’envoi. Cette commande ne lance pas de release.
