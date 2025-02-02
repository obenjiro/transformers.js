// Worker.js file for doing all transformer-based computations
// Needed to ensure the UI thread is not blocked when running

import {
    AutoTokenizer,

    AutoModel,
    AutoModelForSequenceClassification,
    AutoModelForSeq2SeqLM,
    AutoModelForCausalLM,
    AutoModelForMaskedLM,
    AutoModelForQuestionAnswering,
    T5ForConditionalGeneration,
} from '../../src/transformers.js';

// First, set path to wasm files. This is needed when running in a web worker.
// https://onnxruntime.ai/docs/api/js/interfaces/Env.WebAssemblyFlags.html#wasmPaths
// The following code sets the wasm paths relative to the worker.js
// e.g., /transformers.js/assets/js/worker.js -> /transformers.js/src/
ort.env.wasm.wasmPaths = location.pathname.split('/').slice(0, -1 - 2).join('/') + '/src/'


// Define task function mapping
const TASK_FUNCTION_MAPPING = {
    'translation': translate,
    'text-generation': text_generation,
    'masked-language-modelling': masked_lm,
    'sequence-classification': sequence_classification,
    'question-answering': question_answering,
    'summarization': summarize
}

// Listen for messages from UI
self.addEventListener('message', async (event) => {
    const data = event.data;
    let fn = TASK_FUNCTION_MAPPING[data.task];

    if (!fn) return

    let result = await fn(data);
    self.postMessage({
        task: data.task,
        type: 'result',
        data: result
    });
});

// Define model factories
// Ensures only one model is created of each type
class ModelFactory {
    static path = null;
    static tokenizer_class = AutoTokenizer;
    static model_class = AutoModel;
    static instance = null;

    constructor(tokenizer, model) {
        this.tokenizer = tokenizer;
        this.model = model;
    }

    static async getInstance(progressCallback = null) {
        if (this.path === null) {
            throw Error("Must set path")
        }
        if (this.instance === null) {
            let [tokenizer, model] = await Promise.all([
                this.tokenizer_class.from_pretrained(this.path),
                this.model_class.from_pretrained(this.path, progressCallback)
            ])

            this.instance = new this(tokenizer, model);
        }

        return this.instance;
    }
}

class TranslationModelFactory extends ModelFactory {
    static path = 'https://huggingface.co/Xenova/t5-small_onnx-quantized/resolve/main/';
    static model_class = AutoModelForSeq2SeqLM;
}

class TextGenerationModelFactory extends ModelFactory {
    static path = 'https://huggingface.co/Xenova/distilgpt2_onnx-quantized/resolve/main/';
    static model_class = AutoModelForCausalLM;
}

class MaskedLMModelFactory extends ModelFactory {
    static path = 'https://huggingface.co/Xenova/bert-base-cased_onnx-quantized/resolve/main/';
    static model_class = AutoModelForMaskedLM;
}

class SequenceClassificationModelFactory extends ModelFactory {
    static path = 'https://huggingface.co/Xenova/bert-base-multilingual-uncased-sentiment_onnx-quantized/resolve/main/';
    static model_class = AutoModelForSequenceClassification;
}

class QuestionAnsweringModelFactory extends ModelFactory {
    static path = 'https://huggingface.co/Xenova/distilbert-base-uncased-distilled-squad_onnx-quantized/resolve/main/';
    static model_class = AutoModelForQuestionAnswering;
}

class SummarizationModelFactory extends ModelFactory {
    static path = 'https://huggingface.co/Xenova/distilbart-cnn-6-6_onnx-quantized/resolve/main/';
    static model_class = AutoModelForSeq2SeqLM;
}

async function translate(data) {
    let translationModelFactory = await TranslationModelFactory.getInstance(data => {
        self.postMessage({
            type: 'download',
            task: 'translation',
            data: data
        });
    })

    let tokenizer = translationModelFactory.tokenizer
    let model = translationModelFactory.model

    let text = `translate ${data.languageFrom} to ${data.languageTo}: ${data.text}`

    let input_ids = tokenizer(text).input_ids
    let outputs = await model.generate(input_ids, {
        ...data.generation,
        callback_function: function (beams) {
            let skip_special_tokens = true;
            const decodedText = tokenizer.decode(beams[0].output_token_ids, skip_special_tokens)

            self.postMessage({
                type: 'update',
                target: data.elementIdToUpdate,
                data: decodedText
            });
        }
    })

    return tokenizer.decode(outputs, true);
}

async function text_generation(data) {

    let textGenerationModelFactory = await TextGenerationModelFactory.getInstance(data => {
        self.postMessage({
            type: 'download',
            task: 'text-generation',
            data: data
        });
    })

    let tokenizer = textGenerationModelFactory.tokenizer
    let model = textGenerationModelFactory.model

    let text = data.text.trim();
    let input_ids = tokenizer(text).input_ids
    model.generate(input_ids, {
        ...data.generation,
        callback_function: function (beams) {
            const decodedText = tokenizer.decode(beams[0].output_token_ids, true)

            self.postMessage({
                type: 'update',
                target: data.elementIdToUpdate,
                data: text + decodedText
            });

        }
    }).then((outputs) => {
        // TODO: do something with outputs?
        // self.postMessage({
        //     type: 'complete',
        //     target: data.elementIdToUpdate,
        // });
    })
}


async function masked_lm(data) {

    let maskedLMModelFactory = await MaskedLMModelFactory.getInstance(data => {
        self.postMessage({
            type: 'download',
            task: 'masked-language-modelling',
            data: data
        });
    })

    let tokenizer = maskedLMModelFactory.tokenizer;
    let model = maskedLMModelFactory.model;

    let inputs = tokenizer(data.text);
    let output = await model(inputs);

    let mask_token_index = inputs.input_ids.indexOf(tokenizer.mask_token_id)

    // sample from outputs
    let sampled = output.sample(mask_token_index, data.generation)

    let samples = tokenizer.decode(sampled, true);
    self.postMessage({
        type: 'update',
        target: data.elementIdToUpdate,
        data: samples.join('\n')
    });

    return samples;
}

async function sequence_classification(data) {

    let classificationModelFactory = await SequenceClassificationModelFactory.getInstance(data => {
        self.postMessage({
            type: 'download',
            task: 'sequence-classification',
            data: data
        });
    });
    let tokenizer = classificationModelFactory.tokenizer;
    let model = classificationModelFactory.model;

    let inputs = tokenizer(data.text)

    let outputs = await model(inputs)

    self.postMessage({
        type: 'complete',
        target: data.elementIdToUpdate,
        targetType: data.targetType,
        data: outputs
    });
}


async function question_answering(data) {

    let questionAnsweringModelFactory = await QuestionAnsweringModelFactory.getInstance(data => {
        self.postMessage({
            type: 'download',
            task: 'question-answering',
            data: data
        });
    })

    let tokenizer = questionAnsweringModelFactory.tokenizer;
    let model = questionAnsweringModelFactory.model;

    // question, text
    let inputs = tokenizer(data.question, data.context);

    let output = await model(inputs);

    let answer = tokenizer.decode(output.answer_tokens, true);

    self.postMessage({
        type: 'complete',
        target: data.elementIdToUpdate,
        data: answer
    });

    return answer;
}

async function summarize(data) {
    let summarizationModelFactory = await SummarizationModelFactory.getInstance(data => {
        self.postMessage({
            type: 'download',
            task: 'summarization',
            data: data
        });
    })

    let tokenizer = summarizationModelFactory.tokenizer
    let model = summarizationModelFactory.model

    let input_ids = tokenizer(data.text).input_ids
    let outputs = await model.generate(input_ids, {
        ...data.generation,
        callback_function: function (beams) {
            let skip_special_tokens = true;
            const decodedText = tokenizer.decode(beams[0].output_token_ids, skip_special_tokens)

            self.postMessage({
                type: 'update',
                target: data.elementIdToUpdate,
                data: decodedText.trim()
            });
        }
    })

    return tokenizer.decode(outputs, true);
}
