import { eventSource, event_types, getCurrentChatId } from '../../../../script.js';
import { power_user } from '../../../power-user.js';

let generation_data = {};

eventSource.on(event_types.TEXT_COMPLETION_SETTINGS_READY, (args) =>{
    let instruct = {
        'collapse_newlines': power_user.collapse_newlines
    };
    Object.assign(instruct, power_user.instruct);
    Object.assign(args, {
        'grimoire': {
            'chat_id': getCurrentChatId(),
            'instruct': instruct,
            'generation_data': generation_data
        }
    });
});

eventSource.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, (args) =>{
    console.log(args)
    generation_data = args;
});