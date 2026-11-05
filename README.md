# TextMachine

**De vos lectures à une newsletter illustrée, sans quitter Obsidian.**

Google Alerts, Google Scholar, services de veille, liens envoyés par vous ou vos lecteurs, flux RSS… TextMachine rassemble ces sources, récupère les articles et prépare une revue de presse avec citations et liens. Une illustration originale accompagne le texte ; les sources dont le contenu reste inaccessible apparaissent en fin de note, dans **En bref**.

Vous choisissez les sources, les consignes et le modèle d’IA. La newsletter reste une note Markdown dans votre coffre, à relire et à modifier avant publication. Les prompts fournis portent sur l’intelligence artificielle, l’écriture et les métiers du livre ; vous pouvez les adapter à votre sujet.

[Installer TextMachine depuis Obsidian](https://community.obsidian.md/account/plugins/text-machine) · [Signaler un problème](https://github.com/tcrouzet/textmachine/issues)

## De la collecte à la newsletter

[![Organigramme vertical : alertes Google, autres services et mails personnels rejoignent un libellé Gmail ; les flux RSS complètent la collecte. Les liens sont filtrés et les articles lus, puis les prompts sélectionnent les sources, rédigent et révisent le texte, créent le titre, le chapeau et l’illustration. Les sources inaccessibles passent par une branche En bref. Les anciennes publications servent à éviter les répétitions. Le plugin assemble et enregistre la note finale.](doc/processus.svg)](doc/processus.svg)

## Installer TextMachine

Obsidian **1.11.4 ou ultérieur**, sur ordinateur, est requis. Le plugin est gratuit, sous [licence MIT](LICENSE). Les appels aux services d’IA dépendent de votre abonnement ou de votre facturation API.

1. Dans Obsidian, ouvrir **Réglages → Plugins communautaires → Parcourir**.
2. Chercher **TextMachine**, puis choisir **Installer** et **Activer**.
3. Ouvrir **Réglages → TextMachine** pour configurer la collecte et l’IA.

[Ouvrir la fiche TextMachine sur Obsidian](https://community.obsidian.md/account/plugins/text-machine).

**Connexion Gmail :** cette version exige un client OAuth Google pour ordinateur, avec l’API Gmail activée. Son fichier de configuration, au format Google `installed`, doit être placé dans `oauth-client.json` à la racine du dossier du plugin. Ce fichier n’est pas distribué avec les releases. Sans cette configuration, le bouton de connexion reste indisponible.

## Préparer sa veille

Dans **Réglages → TextMachine** :

1. Saisir son adresse Gmail, cliquer sur **Connecter** et autoriser l’accès dans la fenêtre Google.
2. Choisir le **Libellé source**. Lui affecter les alertes, les messages de veille et les mails contenant des liens à lire. Un lien envoyé à votre propre adresse peut ainsi rejoindre la collecte.
3. Créer le dossier des données, nommé `TextMachine` par défaut, ou choisir un dossier existant vide.
4. Configurer l’IA pour le texte et une clé OpenAI pour l’illustration.
5. Choisir la **Langue de la newsletter** et le **Minimum d’articles avec texte** : **10 par défaut**, avant la sélection éditoriale. Les titres seuls, les PDF et les articles inaccessibles ne comptent pas dans ce minimum.

La section **Newsletter → Sources** permet d’affiner la collecte :

- **Include feeds** ajoute des flux RSS ou Atom aux articles reçus par mail. Plusieurs adresses peuvent être séparées par des espaces ou des retours à la ligne. Une adresse Substack est convertie en adresse de flux.
- **Author feeds** fournit vos publications récentes comme historique des sujets déjà traités. Ces publications sont exclues des sources de la newsletter. Le plugin lit les flux et transmet leur contenu à l’IA.
- **Sources de référence** indique les domaines à privilégier parmi les sources disponibles, par exemple `theguardian.com`.
- **Sources exclues** écarte un domaine ou une catégorie de source. `youtube` filtre notamment `youtube.com` et `youtu.be` ; `Google Alerts` filtre cette source de collecte.
- **Sites bloqués** affiche les domaines que le plugin ne peut pas lire : connexion nécessaire, abonnement, filtrage… Ils sont mémorisés pour éviter de les interroger à nouveau.

## Lancer une édition

Dans l’explorateur, faire un **clic droit sur le dossier TextMachine → Text Machine**. Une icône de machine à écrire repère ce dossier. La commande propose de se reconnecter ou de créer le dossier si nécessaire.

TextMachine traite les messages **non lus** du libellé choisi et les flux complémentaires. Il extrait les liens vers les articles, élimine les doublons par URL ou titre et conserve leur origine. Les messages sont marqués comme lus après l’enregistrement des liens. Les pages sont ensuite chargées pour extraire leur texte, leurs auteurs et leur date de publication. Un article dont le texte est déjà enregistré n’est pas relu.

Une fois le minimum d’articles lisibles atteint, les étapes IA démarrent. La fenêtre de traitement affiche le fournisseur, le modèle, l’avancement et le texte reçu progressivement. Fermer cette fenêtre annule le traitement.

Le résultat s’ouvre dans **`text-machine-AAAA-MM-JJ.md`** : titre, chapeau, article avec liens vers les sources, illustration après le deuxième paragraphe, puis **En bref**. Cette dernière rubrique contient uniquement les titres traduits et les liens des articles inaccessibles ou non vérifiables, y compris les PDF. Leur contenu n’est pas envoyé à l’IA.

Pour une newsletter en français, les corrections typographiques de Finition sont appliquées localement : apostrophes, guillemets, espaces insécables, notamment avant les deux-points, et ponctuation. Finition n’a pas besoin d’être installé.

## Des prompts pour chaque étape

Dans **Réglages → TextMachine → Newsletter → Prompts**, cliquer sur **Modifier** en face de l’étape à personnaliser. Une grande zone de texte affiche les consignes actuelles et les variables disponibles. **Enregistrer** applique les changements à la prochaine génération ; **Annuler** conserve le prompt existant. Ces réglages restent accessibles sans connexion Gmail.

Les consignes sont enregistrées dans les fichiers du dossier [`prompts/`](prompts/) du plugin, relus à chaque lancement. Si un fichier local manque, l’éditeur affiche la version embarquée et crée le fichier lors de l’enregistrement. Les prompts vides, les variables inconnues et l’absence des variables d’entrée obligatoires sont signalés avant la sauvegarde.

| Prompt | Ce qu’il reçoit et produit |
| --- | --- |
| [`sélection.md`](prompts/sélection.md) | Examine les articles complets et l’historique. Choisit les sources complémentaires et écarte les sujets déjà traités, les textes sans apport et les annonces d’événements passés. |
| [`writer.md`](prompts/writer.md) | Reçoit les articles retenus et rédige les paragraphes. Les consignes fournies visent une revue de presse orale de 1 500 signes, qui passe d’une source à l’autre par des faits et des citations attribuées. |
| [`bref.md`](prompts/bref.md) | Reçoit seulement les titres des sources inaccessibles et les traduit pour **En bref**. |
| [`rewriter.md`](prompts/rewriter.md) | Révise uniquement le corps de l’article, sans image, titre ni chapeau. Si la révision échoue ou altère les liens, le texte initial est conservé. |
| [`publisher.md`](prompts/publisher.md) | Reçoit le texte finalisé et propose son titre et son chapeau. |
| [`image.md`](prompts/image.md) | Guide la création d’un dessin à partir du titre, du chapeau et du texte final. Les consignes fournies demandent une scène humoristique en noir et blanc, sans texte. |

Les étapes textuelles renvoient du JSON, validé avec les schémas de [`models/`](models/). Le plugin assemble leurs résultats dans [`models/newsletter.md`](models/newsletter.md) et met lui-même à jour le suivi des articles. Le modèle Markdown ne fait pas partie des consignes envoyées à l’IA.

Le thème, la longueur, le ton et le style du dessin se règlent dans cet éditeur. Pour modifier aussi la mise en page, copier [`models/newsletter.md`](models/newsletter.md) dans le dossier `models/` du plugin et adapter ce fichier.

Les variables utilisent la syntaxe `{{nom}}` :

| Variable | Contenu fourni par le plugin |
| --- | --- |
| `{{language}}` | Langue choisie dans les réglages. |
| `{{articles}}` | Articles avec leur texte, leurs métadonnées et leurs identifiants : disponibles pour la sélection, retenus pour la rédaction. |
| `{{previousNewsletters}}` | Texte des cinq dernières newsletters des autres jours, pour éviter les répétitions. Disponible dans la sélection et la rédaction. |
| `{{AuthorFeed}}` | Titres, liens et textes des cinq publications récentes par flux d’auteur. Disponible dans la sélection, la rédaction et la révision. |
| `{{now}}` | Date et heure courantes, réservées à la sélection pour vérifier les annonces d’événements. |
| `{{article}}` | Texte finalisé transmis au prompt de titre et de chapeau. |

Pour la révision, **En bref** et l’illustration, le plugin joint directement les données nécessaires : inutile d’ajouter une variable pour leur contenu.

## Une illustration par jour

L’illustration est un **PNG noir et blanc au format horizontal 4/3**, de 1600 × 1200 pixels. Elle est enregistrée dans `illustrations/text-machine-AAAA-MM-JJ.png`, à côté des notes dans le dossier des données.

La génération d’images utilise l’API OpenAI et sa clé, quel que soit le modèle choisi pour le texte. Si l’image du jour existe déjà, elle est réutilisée, même après modification du texte ou du prompt. Un échec de création de l’image empêche l’enregistrement de la nouvelle édition.

## Régénérer et garder le suivi

Relancer **Text Machine** réécrit la note du jour avec les articles disponibles pour cette date et les nouveaux articles collectés. L’image existante est conservée.

Après une édition enregistrée, tous les articles disponibles pour cette génération reçoivent une date `usedAt`, y compris ceux que la sélection n’a pas retenus. Cela évite leur retour dans une édition suivante, tout en permettant de régénérer celle du jour. Leur état de lecture reste distinct : un article inaccessible conserve le statut `forbidden`.

Si vous supprimez les newsletters des jours précédents, les articles de ces journées redeviennent utilisables, jusqu’à la dernière édition encore présente. Les données restent dans `textmachine.json` ; le plugin détermine leur disponibilité à partir des notes restantes.

Activer **Debug**, en bas des réglages, conserve `brouillon-AAAA-MM-JJ.md` et `revision-AAAA-MM-JJ.md` pour comparer l’écriture et la révision. Ce mode est désactivé par défaut.

## Choisir son IA

Les réglages reprennent le fonctionnement de Finition :

- **OpenAI ou Anthropic** : choisir ou créer une clé dans le gestionnaire de secrets d’Obsidian, puis sélectionner le modèle. Les champs affichent les références des clés, partageables avec d’autres plugins.
- **Codex** : installer et connecter Codex CLI sur la machine. TextMachine propose les modèles disponibles et leur effort de raisonnement. Ce choix reste propre au plugin.
- **Serveur local compatible OpenAI** : renseigner son adresse et le nom du modèle déjà installé sur ce serveur.

Codex est prioritaire lorsqu’il est choisi ; sinon, un serveur local renseigné prend la priorité sur le modèle cloud. Une erreur ne provoque pas de bascule automatique vers un autre fournisseur. L’illustration nécessite toujours une clé OpenAI lorsqu’elle doit être générée.

## Confidentialité et publication

Les liens, les textes extraits, les dates d’utilisation, les notes et les images sont enregistrés dans votre coffre. Les clés API et la session Gmail sont conservées dans le gestionnaire de secrets d’Obsidian. Le mot de passe Google est saisi chez Google.

L’autorisation Gmail permet de lire et de modifier les messages du compte ; TextMachine limite sa collecte au libellé choisi et marque les messages traités comme lus. Les pages d’articles sont chargées dans une fenêtre isolée, sans accès à votre coffre ni aux sessions de votre navigateur habituel. Les PDF ne sont pas lus.

La sélection et la rédaction transmettent les textes des articles et l’historique utilisé au fournisseur choisi. Un serveur exécuté sur votre machine permet de traiter le texte localement ; Codex utilise le service auquel il est connecté. La génération d’images transmet le texte final à OpenAI. Les titres des sources inaccessibles sont envoyés séparément pour traduction.

**La commande prépare une note à relire. Elle ne publie pas sur Substack et n’envoie rien aux abonnés.** Les scripts RSS et Substack présents dans le dépôt sont des outils séparés du plugin.

## Sources et développement

Le code du plugin est dans [`plugin/`](plugin/), les tests et les outils dans [`scripts/`](scripts/). L’extraction du texte s’appuie sur [Readability](scripts/vendor/readability/LICENSE.md) ; les domaines des sites bloqués sont regroupés grâce à la [Public Suffix List](scripts/vendor/MPL-2.0.txt).

Les commandes de vérification sont `npm test`, `npm run typecheck` et `npm run lint`. `npm run build` construit le fichier installable `main.js`.

Un problème ou une idée ? [Ouvrir un ticket](https://github.com/tcrouzet/textmachine/issues), avec la version d’Obsidian, le système et l’étape concernée.
