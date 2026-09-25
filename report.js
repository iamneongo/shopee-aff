const axios = require("axios");

// ===== Cấu hình thời gian (Unix timestamp - giây) =====
const now = Math.floor(Date.now() / 1000);
const sevenDaysAgo = now - 7 * 24 * 60 * 60; // 7 ngày gần nhất

// ===== Headers + Cookie (copy y nguyên từ request tạo link của bạn) =====
const commonHeaders = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en,vi;q=0.9,vi-VN;q=0.8,fr-FR;q=0.7,fr;q=0.6,en-US;q=0.5",
  "af-ac-enc-dat": "821b2c2af5805702",
  "af-ac-enc-sz-token":
    "KQN9lJh7lgecwN4pXOO39Q==|ZAdFX9Arq3d4fF/GpSMVaBsO/Iys7uJ2NHNxfgJuXBjR1QdAlGC2HsIOO/RRuTND+DEPmgxGXjU=|YGf4czggvxoYJmQO|08|3",
  "affiliate-program-type": "1",
  "content-type": "application/json; charset=UTF-8",
  "csrf-token": "yuf4IvFQ-WNEV4bLRCITCGnK0NS-0wXZJqm8",
  origin: "https://affiliate.shopee.vn",
  priority: "u=1, i",
  referer: "https://affiliate.shopee.vn/report/conversion_report", // đổi referer cho đúng trang report
  "sec-ch-ua":
    '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  "x-sap-ri": "d627b66ab2e1b3873b64483c05015c2199d4b53ba3c43119df80",
  "x-sap-sec":
    "9K71rB4ttX5YFDiYDXkYDD0YsXrEDT9YnrrCDT+YGNkODX1YAXryDATYPNk1DqiYVXkPDFiYtXrHDuqY1XOZDq0YIXk7DTkYCNOQDX+YmXrBDuaYwNOKD9SYuXOaDq9YeXkKDD9YGXOqDF+YEjOjD9aY9Xr0Du9YyNOyDt9YvXrFDDYYyrrEDXkY/XoYDXkYDXIZhju7DXkYv7c0hqc7DrkYDXkYLgfYAFXYDrkYlXSYD8GGQZ9YDA42lXoYDXkYdsyYDArYDXkBRB9CDXkY4AWaZXkYD19CDXk0DNkYqEstiNkYDu6aDjkYmXSYDXkY7C/BO8vKDXkY90+aIfk0DjkYDXkwLgiwDXOm4NPjeY1GN2L4D9PdDrkYDXkVD+iGDXPYDjkYDFD964+GYhns0vfoDXriReoYDXPm4dQpaoLfl2mIg+waY/60QHcdLmKD0Qjs6uH35sNEBD8MKpB4FS1kNvJhBChdcvTm9AuB7xm7Ie6wXChyIznqA1rUc8Rg2051Ej2TyS5bE3ANtsr/xg5g1385R0K9si6aJ2xoqTmiqWasHY4l6EfCAZqeEE47Fkf8mDb0h6kO2gRNn92mD2Wb+k7d+/1t2DkcMLtLTCioNIBZfypG6/cipk/Kn4DIkWzjbjqUi4OYjJozcYdztoCrApUgHlUTsxS1P/Wvnof/kcLmqzJ2Q5X/TCMuGkueQjGNcbABoLjVdQkQDXkiDXkYEegxlEdtk2aaDXkYAs0y/hiYDXraIlJaqITPJ5yJJAvhKEn9q10xb1zWUOgVTx3HD0aFER1AakY+9yxeIOIfi+bksQiiHLSF2t28H8TLR9vEKORCSqujW+iAqDP93qj/B4jnb1On0s8ZEksHoss4vZIn6yCQGKpLFpMFFsVhUwPxk1qhaDmqkq1VJPzlC2ZTUYSk+Df7loZvK8q9oRFibeOvbnxnjNocIQqCviJc+VJiBv4ZaiuZ6rhoQQ6ZVylWFXkYD9u5vZ7gDXkYtU3KNyFH62d+7v+YDXkYDXkYDXr9DXkYm0CgeM8P2EzgPUPgVqKnrTBpSuYChxG+y/FdpjW4h0iIKuvXAtvIMmQL6VHAE3KyteP5NPFL20jCoCClAhZ60W326qyDJUeLtEO4kWhQ4wiBKu891Zt3PjkYDXkYDXkYDXkYD9SYDXr3hhnCDCsedFeIp2SCSKeX1tKKD8+YDXrKsxtDiK87+Pvh07z9LehAue82B4ZN604JhGCzjZF0NmM7SuTYDXkYqXkYDWGNS1jVoZCinKLI4yl5s7TIs/BfiZgQ4OeLHSTi6n3DnsQQ+jGB3SaeshnljUG6NOCsHpbDpZeWDXkYDX9YDXkIzA74RatvpXkYDXkYDXkY1XkYDT8ASGU6EyRMVT1CHNdiqa4rFscc510mANXfbgMohFIMl1FJyQY73ooiDXkYFSPy7cm8MsiiDXkYtBA2nWTkZO9YDXkY",
  "x-sz-sdk-version": "1.12.21",
  Cookie:
    "_hjSessionUser_868286=eyJpZCI6IjgwNTBiZmE3LWViMjktNTM4ZC05OWRkLTc2ZTQ3OTE0ZDU3YSIsImNyZWF0ZWQiOjE3NDA1Mzc2Mzg0NDEsImV4aXN0aW5nIjp0cnVlfQ==; language=vi; _fbp=fb.1.1779970355467.253326898523963020; SPC_F=r8RBQfj8ryR6oESQyAAbkMLVZ5o8s7AB; REC_T_ID=88ec2be3-5a8e-11f1-8c47-e26d1f905fb5; SPC_CLIENTID=cjhSQlFmajhyeVI2yizypbhonesuaqfu; _med=refer; _QPWSDCXHZQA=056f4084-8351-405a-d28c-84f49c73e300; REC7iLP4Q=f9eddb24-d16a-406f-91a1-695e4b3c27ea; csrftoken=HIzlfbbr0jirEzBebxwVThgFsvyHOw4G; SPC_CDS_CHAT=a8d711cc-be9d-4a4a-8510-1d906160e29e; _ga_FV78QC1144=GS2.1.s1787705955$o2$g0$t1787705957$j58$l0$h0; _gcl_au=1.1.132270903.1787822046; _gcl_gs=2.1.k1$i1787822043$u184255844; _gcl_aw=GCL.1787822049.CjwKCAjwwL_UBhAjEiwAEhuT5DMtN6VM95fSTA7TgrgGto6LeGuYkHkPX6jv9ePP0blNooWSrh27pxoCcKAQAvD_BwE; _fbc=fb.1.1789634891136.IwY2xjawUYiHpwZG9mBWV4dG4DYWVtAjEwAGJyaWQRMVR1THAwT1ROOHNHT2N6dFZzcnRjBmFwcF9pZBAyMjIwMzkxNzg4MjAwODkyAAEeqL0-NizR9to96YvZQ-TUh8Z8ZRNUrkb3t0u9_9yktVarHvOmMJ-Kum_jcG4_aem_8i1-_qMDdtrgzsXhSUaC7w; language=vi; _sapid=89d78b845f2b0fee8c8a478653b2e7ab4eb2c10c1bfe153b8bbd3f5f; SPC_EC=-; SPC_ST=0VGGBWmHNqGnucyTxggAgHSsh43oQdSlcQ+lCPxv9uUJU01tkzw8r9a586n+Kpu5qN2d4cynX8e8QFm9eK5o2JPER4PwIKwMn+3MTfPaCXPZj6To67OHQmiApzVKP09QPiEACgSJ2UFUVXJtFZsJv4WO0cOsmkht1XsACs5vfkex3Nm2d0L9JQSWDCLYCvRaZRI9Oj49ZJRm5OPjLyCUCQ==.AG2EH7GD0TQ69gyHORPpqZd5gWF7PQxFb6yp/z3U7A0d; SPC_U=15310688470; SPC_R_T_IV=UUNkZWNZUWI1NmVhZnRZbQ==; SPC_T_ID=Z9S5WO9ZFVXlb6nGtw8Uy0zoAyjcCxOoxTxhmhHufTWkftEh2yJdIH+5TYJUNI3AxA8NXJj+I8vnA6w9CGmBnzshFnPU5xxHy15/4997BBd+qoTVkI+qaYVSpboI1LMsPYuqRi6UwQRqJIQeUXO/74ns2iczREfTV0h9TyJqDwQ=; SPC_T_IV=UUNkZWNZUWI1NmVhZnRZbQ==; SPC_R_T_ID=Z9S5WO9ZFVXlb6nGtw8Uy0zoAyjcCxOoxTxhmhHufTWkftEh2yJdIH+5TYJUNI3AxA8NXJj+I8vnA6w9CGmBnzshFnPU5xxHy15/4997BBd+qoTVkI+qaYVSpboI1LMsPYuqRi6UwQRqJIQeUXO/74ns2iczREfTV0h9TyJqDwQ=; _med=refer; SPC_SI=yqKGagAAAAB4UDJKTk9ISvIQbgUAAAAAMHNqYkhBZ1M=; _gid=GA1.2.1929226373.1790305918; _ga=GA1.1.2129657950.1740367584; _ga_44R8KFLXBB=GS2.1.s1790305918$o1$g0$t1790305923$j55$l0$h0; AC_CERT_D=gqRjZGVrxHeFomtpuDE0MjUxOmNhcHRjaGFfY29va2llX2tleaJrdtEAAqRhbGdv0gAAAGSjZGVrwKJjdMRAAAAADN9z5kEMJB0Wg2MfLZ9FmHLvEv0mCiUGsufBi1VPmDbIHRGq7qYYM9e1G/ixNaEqk7KYc2SVgmSRUExAQqpjaXBoZXJ0ZXh0xQM+AAAADGeQOuJtV0k4h0eokxyyBiLk+zlMblWx/Ow1W2VRxWOqq89ifloxTPiNRq80ovb1x9kfK/TsH49RUMzfs9pMI6rgLkw9p9JwoWo2UvXxNiB9B/pbFpCgyiNYIX5/6NXr03BQvD2WtwGP91CtZwXa4HnP0VFN2JZXrwtbpPMvQkH6InHl8mWl3tPw5wVRWH8LZFFc6w6VYFoK+5XvTyU6soAoHrCyFypSS7noOPmMG9nq2rrcJcuq4rxGstDnn8v8XSIrCS09SRLOfcfVXCaeZljiK0AzgIbWn1EQedM031F7qQ/kv09E515Zgvo7ZQCRQKOqsyXXCHL9oFwYQ0a5Zk+Qdcnq0pgGPLjkGCYjIt+VoQsdIS3vl3Hn6h9JJGmV1Y28TmslB4NlR0dvJL8Ea7cbTKRxaaaeZuX/1752WJehwcc87nUTCSHD7IfYWPqQwjD57hCcjUceN8N/0Z76y7eTZgy24XSfB2Ol52bOopL/GDVusJdG/xBt3TWdao0RysbtDI5PoknlGPVPNqzfX3Dt7GAhIbmQhY8UlizRgmYhzobzvsxOMYfCUJnVV0mkiQ5yK577VH1KffC6WvSXZeIkN0XyVk4W2OkhJIqT6PJAzP7nyrkwZM4oLP6/As4K9VOBaOyvhCh4wA0t3q2O6L3mEghvpHgrhBQsZkCqWyfl9y3gD4Iq66Ht7Q4Vwc2IJR0IdSUCL1B/b5aD3ebeNS6CIsWNNKLzf5fQnQGArnYarxL0Y0mWcNCNfQlG8xCJUYhXPuX3zcCUBMw5ovsoHf+fYRB0YgPHnf8otB+GoxpxHjBN18caYKWkHzY04FOPtW8RGiTzRTopIzgid0oVA/0XcSYvEtYjdoJuxhLCVSKi29C4wedmDupjB2Qz9HNAfnPk/O3zyfpRlwwAoJ6DmK04Nq+6K0643WTqAkulrKNLQS4Wrw9N7m3bzKydvmEpAsthIFielkNDjHUq8NASe1FyD/N4Dd+t0bIE79YxMlhjlTdk6jpRhw0xcxNxpxLYCV5GEqVzHW+fn6bZskMS7z9jA4hxrp2Qgd60FlwFkaYx5XDU/eHe9Nw9go3lZHVlQFNCpCet5aHIGyA=; sense_sa_r=s; shopee_webUnique_ccd=Kbv4IvqvM10QhKzXW2eJ%2Fg%3D%3D%7CwNuv6rMx%2F197t%2Fv6vvvG1JA5LwZJYp6Wo7D1QmPevPwGwHnExyBra6TVzRabQaWmEciOMnsXyDY%3D%7Ce9UBKUVKDylAJ%2BVU%7C08%7C3; ds=be6ef97a79fa617e6c962a4caca028a1; _ga_4GPP1ZXG63=GS2.1.s1790319250$o99$g1$t1790322620$j21$l0$h1257064916",
};

async function getConversionReport() {
  try {
    const res = await axios.get(
      "https://affiliate.shopee.vn/api/v3/report/list",
      {
        params: {
          page_num: 1,
          page_size: 50, // 20 / 40 / 100
          purchase_time_s: sevenDaysAgo,
          purchase_time_e: now,
          version: 1,
          // order_sn: 'MÃ_ĐƠN_HÀNG',   // nếu muốn lọc theo 1 order cụ thể
          // order_status: 2,           // 1=Pending, 2=Completed, 3=Cancelled, 4=Unpaid
        },
        headers: commonHeaders,
        maxBodyLength: Infinity,
      },
    );

    console.log(JSON.stringify(res.data, null, 2));

    // Ví dụ in nhanh các đơn
    const list = res.data?.data?.list || res.data?.list || [];
    console.log(`\n→ Tìm thấy ${list.length} đơn hàng:`);
    list.forEach((item, i) => {
      console.log(`\n#${i + 1}`);
      console.log("  Order SN     :", item.order_sn || item.orderId);
      console.log("  Sản phẩm     :", item.item_name || item.itemName);
      console.log(
        "  Hoa hồng     :",
        item.commission || item.estimated_commission,
      );
      console.log(
        "  Trạng thái   :",
        item.order_status || item.display_order_status,
      );
      console.log(
        "  Thời gian    :",
        item.purchase_time
          ? new Date(item.purchase_time * 1000).toLocaleString("vi-VN")
          : "",
      );
      console.log("  SubID        :", item.sub_ids || item.subIds);
    });
  } catch (err) {
    console.error("Lỗi lấy report:", err.response?.data || err.message);
  }
}

getConversionReport();
