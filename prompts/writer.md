À partir des articles fournis, écris ou régénère la newsletter du jour.

# Sélection des articles

Examine tous les articles fournis. Les données regroupent les nouveaux articles et ceux utilisés aujourd’hui.  Vérifie que l'article a un rapport entre la littérature, l'écriture, les romans… et l'intelligence artificielle (IA). Les IDs des articles non sélectionnés doivent figurer dans `discard`.

# Angle éditorial

Avant de rédiger, consulte les anciennes newsletters fournies dans `previousNewsletters` afin d’éviter de reprendre exactement une idée déjà publiée.


Consulte aussi les derniers articles de Thierry Crouzet fournis dans `recentPosts`. S’il évoque déjà un fait, pointe vers cet article plutôt que de le détailler.

Ne rédige pas une simple succession de résumés.

Construis un article journalistique clair autour d’une idée directrice nouvelle, dégagée à partir des articles disponibles. Les articles doivent servir de fil conducteur à cette idée.

L’article doit :

* être écrit en français
* faire environ 1 500 signes
* proposer un angle clair
* relier les informations sans inventer de lien entre elles
* distinguer les faits, les analyses, les déclarations et les hypothèses
* ne pas inventer d’information absente des article.
* traduire les citations en français
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

# Illustration

Désigne dans `lead` l’ID de l’article le plus prestigieux parmi les articles exploités dans le corps du texte. Cite cet article par un lien Markdown dans un paragraphe. Privilégie un média de référence, une rédaction reconnue ou une source primaire responsable de l’information plutôt qu’un agrégateur, un blog secondaire ou une reprise. La disponibilité d’une image ne doit pas influencer ce choix.

Pour `image.caption`, reprends une légende fiable de l’image de cet article principal.

Retrouver une légende fiable dans le texte de cet article. Si elle manque, laisser `caption` vide.

Aucun visage humain, même en arrière-plan ou dans une illustration. Si la description suggère un portrait ou si le doute subsiste, renvoie `image: null`. Si l’article principal n’a pas d’image adaptée, renvoyer `image: null`, même si un autre article possède une image. Ne jamais utiliser l’image d’une source écartée.

# Citations et sources

Troiuve au moins deux citations dans les articles de la revue de presse.

Chaque citation doit :

* reprendre exactement le texte disponible
* être clairement attribuée à sa source
* contenir un lien Markdown vers l’URL de l’article
* être traduite en français (sans préciser que c'est une traduction)

Si aucune citation fiable n’est disponible, n’en invente pas.

# Articles sélectionnés

Si plusieurs articles parlent exactement du même sujet, repère celui qui fait autorité en fonction de sa source, ne conserve que ce dernier.

Regroupe les articles dans des grandes thématiques.

# Sortie

Retourne uniquement un objet JSON conforme au schéma `jsonSchema` fourni avec les données.

Les articles retenus figurent dans les groupes thématiques. Référence-les par leur `id` et place tous les autres IDs dans `discard`. Ne recopie pas les URL dans ces listes.

Si aucun article n’est pertinent, renvoie des chaînes et listes vides, `lead: null` et `image: null`.
