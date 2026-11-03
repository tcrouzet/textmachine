À partir des articles fournis, écris ou régénère la newsletter du jour.

# Angle éditorial

Écris un éditorial de 1500 signes maximum qui fait une synthèse des news du jour, sans ce sentir obligé d'être exhostif, mais sans te centre seulement sur une ou deux sources, sauf si pas d'autre possibilité.

Avant de rédiger, consulte les anciennes newsletters : {{previousNewsletters}}

Éviter de reprendre exactement une idée déjà publiée.

Consulte aussi les publications publiée dans ce feed {{AuthorFeed}}. Si une publication traite déjà d’un fait évoqué, intègre son URL directement dans le texte sous forme de lien Markdown : [expression descriptive](URL). Place le lien sur les mots qui désignent le sujet concerné, sans ajouter de commentaire sur cette référence.

Ne mentionne jamais le « feed », les « publications du feed » ou le contexte documentaire fourni. Utilise uniquement les URL présentes dans les données.

Ne rédige pas une simple succession de résumés.

Construis un article journalistique clair autour d’une idée directrice nouvelle, dégagée à partir des articles sélectionné pour ton éditorial. Les articles doivent servir de fil conducteur à cette idée.

L’article doit :

* être écrit en {{language}}
* faire environ 1 500 signes
* proposer un angle clair
* relier les informations sans inventer de lien entre elles
* distinguer les faits, les analyses, les déclarations et les hypothèses
* ne pas inventer d’information absente des article.
* traduire les citations en {{language}}
* ne te sens pas obligé de citer tous les articles.

Si plusieurs articles racontent exactement le même événement, ne le répète pas inutilement. Utilise-les comme sources complémentaires d’une même idée.

# Le titre

C’est le pont d’accroche, ce qui doit donner envie de lire.

* titre ne comporte ni date ni référence à TextMachine
* simple, direct
* pas de structure allambiquée
* doit refléter l’idée directrice de l’article et non simplement reprendre le titre d’un article source.

# Le Chapeau

Moins de 25 mots, donne envie de lire.

# Le style

 * Pas de phrases tordues du type «L’enjeu devient moins la qualité d’une page que l’histoire que nous lui attribuons.» Évite ces phrases en structre double basées sur une opposition.
 * Phrases simple directe, pas de réthorique.
 * Relis le texte finalisé et vérifie sa lisibilité et sa cohérence.

# Citations et sources

Troiuve au moins deux citations dans les articles de la revue de presse.

Chaque citation doit :

* reprendre exactement le texte disponible
* être clairement attribuée à sa source
* contenir un lien Markdown vers l’URL de l’article
* être traduite en {{language}} (sans préciser que c'est une traduction)

Si aucune citation fiable n’est disponible, n’en invente pas.

# Sortie

Retourne uniquement un objet JSON conforme au format demandé.

# Articles à utiliser

{{articles}}
