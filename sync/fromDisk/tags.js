// @ts-check
const { callbackify } = require('util');
const sqldb = require('@prairielearn/prairielib/sql-db');

const infofile = require('../infofile');

function getDuplicates(arr) {
    const seen = {};
    return arr.filter(v => {
        const present = seen[v];
        seen[v] = true;
        return present;
    });
}

function getDuplicatesByKey(arr, key) {
    return getDuplicates(arr.map(v => v[key]));
}

module.exports.sync = function(courseInfo, questionDB, callback) {
    callbackify(async () => {
        const tags = courseInfo.tags || [];

        // First, do a sanity check for duplicate tag names. Because of how the
        // syncing sproc is structured, there's no meaningful error message if
        // duplicates are present.
        const duplicateNames = getDuplicatesByKey(tags, 'name');
        if (duplicateNames.length > 0) {
            const duplicateNamesJoined = duplicateNames.join(', ')
            throw new Error(`Duplicate tag names found: ${duplicateNamesJoined}. Tag names must be unique within the course.`);
        }

        // We'll create placeholder tags for tags that aren't specified in
        // infoCourse.json.
        const knownTagNames = new Set(tags.map(tag => tag.name));
        const questionTagNames = [];
        Object.values(questionDB).forEach(q => questionTagNames.push(...(q.tags || [])))
        const missingTagNames = questionTagNames.filter(name => !knownTagNames.has(name));
        tags.push(...missingTagNames.map(name => ({
            name,
            color: 'gray1',
            description: 'Auto-generated from use in a question; add this tag to your courseInfo.json file to customize',
        })));

        // Aggregate all tags into a form that we can pass in one go to our sproc
        // Since all this data will be sent over the wire, we'll send it in a
        // compact form of an array of arrays, where each array will correspond to
        // one tag: [tag_name, tag_color_description]. This saves bytes over JSON's
        // typical verbose objects.
        const paramTags = tags.map(tag => ([
            tag.name,
            tag.color,
            tag.description,
        ]));

        const tagParams = [
            // node-postgres will try to convert to postgres arrays, so we
            // need to explicitly serialize ourselves: see
            // https://github.com/brianc/node-postgres/issues/442
            JSON.stringify(paramTags),
            courseInfo.courseId,
        ];
        const res = await sqldb.callAsync('sync_course_tags', tagParams);

        // We'll get back a single row containing an array of IDs of the tags
        // in order.
        const tagIdsByName = res.rows[0].new_tag_ids.reduce((acc, id, index) => {
            acc[paramTags[index][0]] = id;
            return acc;
        }, {});

        // Ensure that all question tags are valid. As we go, build
        // up an array of all the information that we'll need at the DB.
        // As above, we'll use a compact representation to send this information
        // to the DB. We'll have an array of arrays, which each array
        // containing info for one question in the form
        // [question_id, [tag_1_id, tag_2_id, ...]].
        const paramQuestionTags = [];

        for (const qid in questionDB) {
            const question = questionDB[qid];
            const tags = question.tags || [];
            const unknownTags = tags.filter(tag => !(tag in tagIdsByName));
            if (unknownTags.length > 0) {
                throw new Error(`Question ${qid} has unknown tags: ${unknownTags.join(', ')}`);
            }
            const duplicateTags = getDuplicates(tags);
            if (duplicateTags.length > 0) {
                throw new Error(`Question ${qid} has duplicate tags: ${duplicateTags.join(', ')}`);
            }
            paramQuestionTags.push([question.id, tags.map(tag => tagIdsByName[tag])]);
        }

        await sqldb.callAsync('sync_question_tags', [JSON.stringify(paramQuestionTags)]);
    })(callback);
}

/**
 * @param {any} courseId
 * @param {import('../course-db').CourseData} courseData
 * @param {{ [wid: string]: any }} questionIds
 */
module.exports.syncNew = async function(courseId, courseData, questionIds) {
    // Tags syncing will have two cases:
    // a) In the first case, we were able to load and validate infoCourse.json,
    // and we have some list of tags to sync. Combined with any tags from questions
    // that were not also listed in infoCourse.json, we know exactly what tags
    // need to exist, in which case we can add any missing tags and safely delete
    // the rest.
    // b) In the second case, we were unable to load or validate infoCourse.json.
    // We can still infer which tags are used by looking at all the tags used in
    // questions, so we can add missing ones if necessary, but we want to avoid
    // deleting any existing tags until we can successfully load/validate
    // infoCourse.json in the future. 
    // To make these work, we'll tell the syncing sproc if infoCourse.json could
    // be loaded, a list of tags from infoCourse.json (if applicable), and a list
    // of "missing" tags that are used by questions but not present in infoCourse.json.
    // If infoCourse.json was loaded, we'll first sync all infoCourse.json tags,
    // then add placeholders for all "missing" tags, then delete unused tags.
    // If infoCourse.json was not loaded successfully, we'll only ensure that all
    // the tags used in questions are present. If they already exist, we won't modify
    // them. We also won't delete any tags in this case.

    /** @type {string[]} */
    let courseTags = [];
    if (!infofile.hasErrors(courseData.course)) {
        courseTags = courseData.course.data.tags.map(t => JSON.stringify([
            t.name,
            t.description,
            t.color,
        ]));
    }

    /** @type Set<string> */
    const knownQuestionTagsNames = new Set();
    Object.values(courseData.questions).forEach(q => {
        if (!infofile.hasErrors(q)) {
            (q.data.tags || []).forEach(t => knownQuestionTagsNames.add(t));
        }
    });
    const questionTagNames = [...knownQuestionTagsNames];

    const params = [
        !infofile.hasErrors(courseData.course),
        courseTags,
        questionTagNames,
        courseId,
    ];

    const res = await sqldb.callOneRowAsync('sync_course_tags_new', params);

    /** @type {[string, any][]} */
    const newTags = res.rows[0].new_tags_json;
    const tagIdsByName = newTags.reduce((acc, [name, id]) => {
        acc.set(name, id);
        return acc;
    }, /** @type {Map<String, any>} */ (new Map()));

    /** @tyle {} */
    const questionTagsParam = [];
    Object.entries(courseData.questions).forEach(([qid, question]) => {
        if (infofile.hasErrors(question)) return;
        /** @type {Set<string>} */
        const dedupedQuestionTagNames = new Set();
        (question.data.tags || []).forEach(t => dedupedQuestionTagNames.add(t));
        const questionTagIds = [...dedupedQuestionTagNames].map(t => tagIdsByName.get(t));
        questionTagsParam.push(JSON.stringify([questionIds[qid], questionTagIds]));
    });

    await sqldb.callAsync('sync_question_tags_new', [questionTagsParam]);
}
