const axios = require("axios");
const readline = require("readline");

// ===== Lấy link từ tham số dòng lệnh hoặc hỏi người dùng =====
async function getOriginalLink() {
  // Cách 1: node script.js "https://s.shopee.vn/xxxxx"
  if (process.argv[2]) {
    return process.argv[2].trim();
  }

  // Cách 2: nếu không truyền tham số thì hỏi
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question("Nhập link Shopee cần tạo affiliate: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const originalLink = await getOriginalLink();

  if (!originalLink) {
    console.error("❌ Bạn chưa nhập link!");
    process.exit(1);
  }

  console.log("→ Đang tạo link cho:", originalLink);

  // SubID (có thể sửa hoặc cũng lấy từ tham số nếu muốn)
  const subIds = {
    subId1: "web",
    subId2: "test",
    subId3: "uTest",
    subId4: "cTest",
    subId5: "v1",
  };

  const data = JSON.stringify({
    operationName: "batchGetCustomLink",
    query: `
      query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller) {
        batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller) {
          shortLink
          longLink
          failCode
        }
      }
    `,
    variables: {
      linkParams: [
        {
          originalLink: originalLink,
          advancedLinkParams: subIds,
        },
      ],
      sourceCaller: "CUSTOM_LINK_CALLER",
    },
  });

  let config = {
    method: "post",
    maxBodyLength: Infinity,
    url: "https://affiliate.shopee.vn/api/v3/gql?q=batchCustomLink",
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language":
        "en,vi;q=0.9,vi-VN;q=0.8,fr-FR;q=0.7,fr;q=0.6,en-US;q=0.5",
      "af-ac-enc-dat": "9943310e97743bff",
      "af-ac-enc-sz-token":
        "Kbv4IvqvM10QhKzXW2eJ/g==|wNuv6rMx/197t/v6vvvG1JA5LwZJYp6Wo7D1QmPevPwGwHnExyBra6TVzRabQaWmEciOMnsXyDY=|e9UBKUVKDylAJ+VU|08|3",
      "affiliate-program-type": "1",
      "content-type": "application/json; charset=UTF-8",
      "csrf-token": "8jGfVwJs-Jbg-Imyaw_MfVtIN4sBl4RNSlek",
      origin: "https://affiliate.shopee.vn",
      priority: "u=1, i",
      referer: "https://affiliate.shopee.vn/offer/custom_link",
      "sec-ch-ua":
        '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
      "x-sap-ri": "e62fb66a94531f012906f53f0501e846ce9e64b4fd3ac8bf09d3",
      "x-sap-sec":
        "YMNc897HWP7Wv4q/UP0/U4k/PPKOUrq/Xg2fUko/fMKdUrY/EgKoUh0/DP2EU4d/480KUJo/z8KNU4T/J80HUkq/EPKIUpo/F82DU4o/hP2CUp7/HM0rUOY/mPKQUJy/SPKlUr0/Yg29UJi/f82IUk+/Z82sU44/X80RUPq/aP2cUs4/nP2qUP0/dP+/UP0/UP69isG9UP0/2XqmD8FvU80/UP0/1EHcdw6BU80/aPd/UE4dGy+/UoGlaP+/UP0/8mo/Uh0XUPLHvFo7UP0/g06WlP0/UHo7UP0fUg0/7ky33M0/U4XKUM0/ZPd/UP0/t4X1hQxCUP0/cAU8jeaxUM0/UPLD1rq3UP2qZ80vY5MTnTTtUHZDU80/UPLfNWY6UPLBUM0/Us2ZDZgdRk2d8R9yUPKVvb+/UPKqPRVImqZFgcfM7fzaT53krZR5YApkrUsOfWAVEFGdZTv5Oe+ZhtwZ5n81V4+PICu96pLyTTZpcVpcfC29rBmBGM/KC1B8Cj8N9zrQgGIL2qhNBgRPhZqjJ3AOY9WuR6QkN1Apuw+B0Pu/VGtC5Bg4Ve/UogBoMBM+VxnAZ9jVMqrwGE1a9FAaL4Tn6SWYlxprFSFqUNRHCGr4rc1ZFXXV0NkDdajP6kcX21RagGvQhPEu2JtNaCZtn5lzdjlgus5EWX8DGVr0tAzyqLPS7LJYnbZ4PvmSTwKhPFGhhU186ceLUP0QUP0/mt1NqdTCwPoKUP0/IW8MJqk/UP0BpUXaR1t5Yj9Nnu5HLtdQVD1isTNFD5fU4KOSQ28ds7YPCE7D6QXh1ca6De8+OFseAtyD+Qi7ZsR3xDRNUM4Qbys7LTMIcVnIWOR9mH+7Yd/S1+GECjtWaIA9q9GiXUeOUyRDJ9QOqiv/lQAwrOrnXr43SVjoaRWBjQRYaomyAwnq21PJ9Xp4pLYI8EGrxqhQrtZFrAKMyMVcw56Myfpm3LQhOnosBIps1itSiee3/5js4mLmUg0/vP0/Uepoai1RUP0/7NXvxyLO7weeFRk/UP0/UP0/UP2IUP0/kD4J9M3S0vv1YdNev0D1kpVDXWozoE8QP929Dj/hsYt2XBa6DLBkBKuyiDbnHUOf7jbjxPLd0YnAgrqsDGPL2e9li84u43c67iaiUWm252tHXBj7Uec2OM0/UP0/UP0/UP0/UOd/UPKkiiYIAslpRsiuTBazencFLRTvUro/UPK5j5wKgn3KNvNTzc5U0ZM8/j6Vb4P/7Y30ikqpfeL/+K1gXWd/UP0/XP0/Ue4xXFrWheWl6TAftysshaZ2jAkEgee+5Uiy9JdZ/KJ96yqWZjJ6/1F+jiYsf3JL+U5A9OHusecTUP0/UPY/UPKpvaEYQScqoP0/UP0/UP0/ng0/USky+ABA3vG7MTqkN+AUF0rtr9hwMbEvUPY/UPLXuQXUxSMqoPY/UP0UW+4qX+kD8g0/UPK=",
      "x-sz-sdk-version": "1.12.21",
      Cookie:
        "_hjSessionUser_868286=eyJpZCI6IjgwNTBiZmE3LWViMjktNTM4ZC05OWRkLTc2ZTQ3OTE0ZDU3YSIsImNyZWF0ZWQiOjE3NDA1Mzc2Mzg0NDEsImV4aXN0aW5nIjp0cnVlfQ==; language=vi; _fbp=fb.1.1779970355467.253326898523963020; SPC_F=r8RBQfj8ryR6oESQyAAbkMLVZ5o8s7AB; REC_T_ID=88ec2be3-5a8e-11f1-8c47-e26d1f905fb5; SPC_CLIENTID=cjhSQlFmajhyeVI2yizypbhonesuaqfu; _med=refer; _QPWSDCXHZQA=056f4084-8351-405a-d28c-84f49c73e300; REC7iLP4Q=f9eddb24-d16a-406f-91a1-695e4b3c27ea; csrftoken=HIzlfbbr0jirEzBebxwVThgFsvyHOw4G; SPC_CDS_CHAT=a8d711cc-be9d-4a4a-8510-1d906160e29e; _ga_FV78QC1144=GS2.1.s1787705955$o2$g0$t1787705957$j58$l0$h0; _gcl_au=1.1.132270903.1787822046; _gcl_gs=2.1.k1$i1787822043$u184255844; _gcl_aw=GCL.1787822049.CjwKCAjwwL_UBhAjEiwAEhuT5DMtN6VM95fSTA7TgrgGto6LeGuYkHkPX6jv9ePP0blNooWSrh27pxoCcKAQAvD_BwE; _fbc=fb.1.1789634891136.IwY2xjawUYiHpwZG9mBWV4dG4DYWVtAjEwAGJyaWQRMVR1THAwT1ROOHNHT2N6dFZzcnRjBmFwcF9pZBAyMjIwMzkxNzg4MjAwODkyAAEeqL0-NizR9to96YvZQ-TUh8Z8ZRNUrkb3t0u9_9yktVarHvOmMJ-Kum_jcG4_aem_8i1-_qMDdtrgzsXhSUaC7w; language=vi; _sapid=89d78b845f2b0fee8c8a478653b2e7ab4eb2c10c1bfe153b8bbd3f5f; SPC_EC=-; SPC_ST=0VGGBWmHNqGnucyTxggAgHSsh43oQdSlcQ+lCPxv9uUJU01tkzw8r9a586n+Kpu5qN2d4cynX8e8QFm9eK5o2JPER4PwIKwMn+3MTfPaCXPZj6To67OHQmiApzVKP09QPiEACgSJ2UFUVXJtFZsJv4WO0cOsmkht1XsACs5vfkex3Nm2d0L9JQSWDCLYCvRaZRI9Oj49ZJRm5OPjLyCUCQ==.AG2EH7GD0TQ69gyHORPpqZd5gWF7PQxFb6yp/z3U7A0d; SPC_U=15310688470; SPC_R_T_IV=UUNkZWNZUWI1NmVhZnRZbQ==; SPC_T_ID=Z9S5WO9ZFVXlb6nGtw8Uy0zoAyjcCxOoxTxhmhHufTWkftEh2yJdIH+5TYJUNI3AxA8NXJj+I8vnA6w9CGmBnzshFnPU5xxHy15/4997BBd+qoTVkI+qaYVSpboI1LMsPYuqRi6UwQRqJIQeUXO/74ns2iczREfTV0h9TyJqDwQ=; SPC_T_IV=UUNkZWNZUWI1NmVhZnRZbQ==; SPC_R_T_ID=Z9S5WO9ZFVXlb6nGtw8Uy0zoAyjcCxOoxTxhmhHufTWkftEh2yJdIH+5TYJUNI3AxA8NXJj+I8vnA6w9CGmBnzshFnPU5xxHy15/4997BBd+qoTVkI+qaYVSpboI1LMsPYuqRi6UwQRqJIQeUXO/74ns2iczREfTV0h9TyJqDwQ=; _med=refer; SPC_SI=yqKGagAAAAB4UDJKTk9ISvIQbgUAAAAAMHNqYkhBZ1M=; _gid=GA1.2.1929226373.1790305918; _ga=GA1.1.2129657950.1740367584; _ga_44R8KFLXBB=GS2.1.s1790305918$o1$g0$t1790305923$j55$l0$h0; AC_CERT_D=gqRjZGVrxHeFomtpuDE0MjUxOmNhcHRjaGFfY29va2llX2tleaJrdtEAAqRhbGdv0gAAAGSjZGVrwKJjdMRAAAAADN9z5kEMJB0Wg2MfLZ9FmHLvEv0mCiUGsufBi1VPmDbIHRGq7qYYM9e1G/ixNaEqk7KYc2SVgmSRUExAQqpjaXBoZXJ0ZXh0xQM/AAAADK8sANCQ70FUugdtnAtpWEw2UqgSKm+VoPG0iLUDX4G0LrUc49aSj0LkKYFmT91wwBpRPbqfv2M6/nEns8sJsQLHmN7VPXKAWELbnD1bjbUF+ce9pLyvpmmHzMJPt/izy9XJLvSZZPJsf7oZJnVuTj6Pr3ykgNRRtBL6g/zgvA+3eohOfDO1tWmNSqpByYKZrdeYA0tmfgrg0l54eopSq/p7IjngAZWzecmJnRFTD5L4ze0wO0BVC3/TIZ/RyGq1IPBOM1qa7/NZRgoNWbc7m8IXRMaU8WKx5KaSKkhZrpBXA0TCCFPjP9RyNQBHbY/3OetQhb/tGl0v9qOfusHcxOLLA/Ah8u8xGgpwHfwAK7tFTkh8F+GcQEPOtn1SpdP88PDjLVYPe6RHZ5upcKAq75571MKDPOFVgOlzj7EpEFbAAKyaPexMdYRzMW4FkidqikvuvKBe7lo3bTxzV1wm7afndwsyLtiF/37Eh9xmozwYh4/4AcJ2jpE6HN8Y//6aZDdRnL8jCklAUnfRTrEynSVAK1LGF8q0NjfFiyO9sMn9+dFKWCr7K6qOc0x0u8XehZK7+pDAb5SRy72JaO31Lk+KV/crBQ9vpxBmmY43shM4lxDoO90YgtX94ucyfLXs94H9rYKx35EgzEaIqfGrd4lIn0LJaDY9X8pVITyEJDrCC6yfo+koXpxVLiaSfBrdQzzt6q+/EbBzQRzyA5OcQ8MHX8R4lZmH1LQX/UCvZGUiuhDG9Cin1u2AxU2rkWpLWmrYzAxwrHZR0VzFz3xXpeHIW5UTpVbAI546yMgiI9M1Y26vxZqnC79fujUBFM2bRSEpynjxEXOUke+sRifIwFH/ZInG8/YxKKWqz4glgEzvRQRC7F0k134jgsOCC07kl6aexL5e9bS/rr3r/yH2O71hHIeTv3ZZeCNLC8ZVHvRRu9T23DmB8CiT4KKaZXPKUfT/Ri0VEh/YM4U7B1BZtRFOe/3dpXwP79kNJ8TcxCJGyyboWF+mYnX6OlvaedNM2KXBt9BM65QTkv7pf31KONXuxo1r2rzn/AvTtjQxvAwslw0r8e/Ff4/5AvPX4DMkTVw2nhdwvveXgl3X; sense_sa_r=s; shopee_webUnique_ccd=HyKGrbuRT6scbsT7f9p5nA%3D%3D%7CmSSjFlzFjPRKDcQK1oMxu6vSQGvNj6qiJLTtgNlQIJlsUJ%2FdG%2Ft43SyGiggU0q9eraklftkjbwaNsQ%3D%3D%7CCQX2Gaz7n4nWBxc0%7C08%7C3; ds=8cac98dc370d46f9e3541778a9bd4922; _ga_4GPP1ZXG63=GS2.1.s1790319250$o99$g1$t1790324711$j53$l0$h1257064916",
    },
    data: data,
  };

  try {
    const response = await axios.request(config);
    console.log("\n✅ Kết quả:");
    console.log(JSON.stringify(response.data, null, 2));

    // In nhanh shortLink nếu có
    const item = response.data?.data?.batchCustomLink?.[0];
    if (item?.shortLink) {
      console.log("\n🔗 Short link:", item.shortLink);
    }
  } catch (error) {
    console.error("❌ Lỗi:", error.response?.data || error.message);
  }
}

main();
