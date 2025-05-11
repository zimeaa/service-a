require('./Tracing'); // Ensure this is initialized first
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { trace, context, propagation } = require('@opentelemetry/api');

const app = express();
const PORT = 3002;
app.use(cors());

app.get('/posts', async (req, res) => {
  const tracer = trace.getTracer('backend-tracer');

  // Extract the traceparent header from the request
  const traceparent = req.headers['traceparent'];
  console.log("Received traceparent header:", traceparent); // Log traceparent for debugging
  if (!traceparent) {
    return res.status(400).send('Traceparent header missing');
  }

  // Parse the traceparent header to get traceId and spanId
  const { traceId, spanId } = parseTraceparent(traceparent);
  if (!traceId || !spanId) {
    return res.status(400).send('Invalid traceparent header');
  }

  // Start the parent span using the span context
  const parentSpan = tracer.startSpan('fetch-posts-operation', {
    parent: context.active(), // This ensures the parent context is used
  });

  // Use the active context to propagate the span
  context.with(trace.setSpan(context.active(), parentSpan), async () => {
    try {
      // Log events directly to the parent span for the GET request
      parentSpan.addEvent('Fetching posts from external API');
      const response = await axios.get('https://jsonplaceholder.typicode.com/posts');
      parentSpan.setAttribute('response.status', response.status);
      parentSpan.addEvent('Posts fetched successfully', {
        itemCount: response.data.length,
      });

      const posts = response.data.map(post => ({
        id: post.id,
        title: post.title,
      }));

      // Call Service B and propagate the span context
      const serviceBSpan = tracer.startSpan('call-service-b', {
        parent: parentSpan, // Use parentSpan directly
      });
      try {
        const headers = {};
        propagation.inject(context.active(), headers); // Inject span context into headers
        const serviceBResponse = await axios.post('http://localhost:3003/process', { posts }, { headers });
        serviceBSpan.setAttribute('response.status', serviceBResponse.status);
        parentSpan.addEvent('Service B response received', {
          status: serviceBResponse.status,
          data: serviceBResponse.data,
        });

        // Forward the response from Service B to the frontend
        res.json(serviceBResponse.data);
      } catch (error) {
        console.error('Error calling Service B:', error.response?.data || error.message);
        serviceBSpan.setStatus({ code: 2, message: 'Service B call failed' });
        parentSpan.setStatus({ code: 2, message: 'Error during Service B call' });
        throw error;
      } finally {
        serviceBSpan.end();
      }
    } catch (error) {
      console.error('Error inside /posts:', error);
      parentSpan.setStatus({ code: 2, message: 'Error during fetch-posts-operation' });
      res.status(500).send('Internal Server Error');
    } finally {
      parentSpan.end(); // End parent span after the operation is complete
    }
  });
});

function parseTraceparent(traceparent) {
  const parts = traceparent.split('-');
  return {
    traceId: parts[1],
    spanId: parts[2],
    traceFlags: parts[3],  // Optional: capture trace flags
  };
}

app.listen(PORT, () => {
  console.log(`Service A is running on http://localhost:${PORT}`);
});
