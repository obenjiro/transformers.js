import {
    Callable,
    indexOfMax,
    softmax,
    log_softmax,
    getTopItems
} from "./utils.js"

class Sampler extends Callable {
    constructor(temperature) {
        super();
        this.temperature = temperature;
    }

    _call(logits, index=-1) {
        // Sample from logits, of dims [batch, sequence_length, vocab_size].
        // If index is specified, sample from [batch, index, vocab_size].
        return this.sample(logits, index);
    }
    sample(logits, index) {
        throw Error("sample should be implemented in subclasses.")
    }
    getLogits(logits, index) {
        let vocabSize = logits.dims[2];

        let logs = logits.data;

        if (index === -1) {
            logs = logs.slice(-vocabSize);
        } else {
            let startIndex = index * vocabSize;
            logs = logs.slice(startIndex, startIndex + vocabSize);
        }

        // add temperature
        if (this.temperature > 0) {
            logs = logs.map(x => x / this.temperature)
        }
        return logs;
    }

    randomSelect(probabilities) {
        // Return index of chosen item
        let sumProbabilities = probabilities.reduce((acc, curr) => acc + curr, 0);

        let r = Math.random() * sumProbabilities;
        for (let i = 0; i < probabilities.length; ++i) {
            r -= probabilities[i];
            if (r <= 0) {
                return i;
            }
        }
        return 0; // return first (most probable) as a fallback
    }

    static getSampler(options) {
        // TODO add beam
        if (options.num_beams > 1) {
            return new BeamSearchSampler(
                options.temperature,
                options.num_beams,
                options.do_sample,
                options.top_k,
            )

        } else if (options.top_k > 0 || options.do_sample) {
            return new TopKSampler(
                options.temperature,
                options.top_k,
            )
        } else {
            return new GreedySampler(options.temperature)
        }
    }
}

class GreedySampler extends Sampler {
    sample(logits, index = -1) {
        // NOTE: no need to do log_softmax here since we only take the maximum
        let logs = this.getLogits(logits, index);
        let argmax = indexOfMax(logs);

        // Note: score is meaningless in this context, since we are performing
        // greedy search (p = 1 => log(p) = 0)
        return [
            [argmax, 0]
        ];
    }
}

class TopKSampler extends Sampler {
    constructor(temperature, k) {
        super(temperature);
        this.k = k;
    }

    sample(logits, index = -1) {
        let [batchSize, seqLength, vocabSize] = logits.dims;
        let k = vocabSize;
        if (this.k > 0) {
            k = Math.min(this.k, k);
        }

        let logs = this.getLogits(logits, index);

        // Get top k tokens
        let topLogits = getTopItems(logs, k);

        // Compute softmax over logits
        let probabilities = softmax(topLogits.map(x => x[1]));

        let sampledIndex = this.randomSelect(probabilities);

        let tokenId = topLogits[sampledIndex][0];
        let score = Math.log(probabilities[sampledIndex]);
        return [
            [tokenId, score]
        ];
    }
}

class BeamSearchSampler extends Sampler {
    constructor(temperature, num_beams, do_sample, top_k) {
        super(temperature);
        this.num_beams = num_beams; // maximum number of beams
        this.do_sample = do_sample; // if true, perform multinomial sampling

        this.top_k = top_k; // if do_sample, sample from top k items
    }

    sample(logits, index = -1) {

        let logs = this.getLogits(logits, index);

        if (this.do_sample || this.top_k > 0) {
            const [batchSize, seqLength, vocabSize] = logits.dims;

            let k = vocabSize;
            if (this.top_k > 0) {
                k = Math.min(this.top_k, k);
            }
            const topLogits = getTopItems(logs, k);

            // Compute softmax over top k logits
            const probabilities = softmax(topLogits.map(x => x[1]));

            return Array.from({ length: this.num_beams }, () => {
                const sampledIndex = this.randomSelect(probabilities);
                const tokenId = topLogits[sampledIndex][0];
                return [tokenId, Math.log(probabilities[sampledIndex])];
            });

        } else {
            // first perform log softmax to get scores over whole distribution
            const logProbabilities = log_softmax(logs);
            const topLogits = getTopItems(logProbabilities, this.num_beams);
            return topLogits;
        }
    }
}

export {
    Sampler,
    GreedySampler,
    TopKSampler,
    BeamSearchSampler
}
