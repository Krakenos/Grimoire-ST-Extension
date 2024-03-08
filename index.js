import { eventSource, event_types, getCurrentChatId } from '../../../../script.js';
import { power_user } from '../../../power-user.js';

eventSource.on(event_types.TEXT_COMPLETION_SETTINGS_READY, (args) =>{
    Object.assign(args, {
        'grimoire': {
            'chat_id': getCurrentChatId(),
            'instruct': power_user.instruct
        }
    });
});